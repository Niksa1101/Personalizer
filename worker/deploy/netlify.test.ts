import { createHash } from "node:crypto"
import { strict as assert } from "node:assert"
import { after, before, describe, it } from "node:test"

import { resetEnvCache } from "@/lib/env"
import {
  createNetlifyClient,
  NetlifyError,
  normalizeSiteFilePath,
  resetNetlifySiteUrlCache,
  validateNetlifyApiBase,
} from "@/worker/deploy/netlify"
import { startNetlifyFake } from "@/scripts/fixtures/netlify-fake"

function sha1(text: string): string {
  return createHash("sha1").update(text).digest("hex")
}

describe("validateNetlifyApiBase", () => {
  it("accepts https and loopback bases", () => {
    assert.equal(
      validateNetlifyApiBase("https://api.netlify.com/api/v1"),
      "https://api.netlify.com/api/v1",
    )
    assert.equal(
      validateNetlifyApiBase("http://127.0.0.1:9999/api/v1"),
      "http://127.0.0.1:9999/api/v1",
    )
  })

  it("rejects non-https remote bases", () => {
    assert.throws(
      () => validateNetlifyApiBase("http://api.example.com/v1"),
      /must be https or loopback/,
    )
  })
})

describe("netlify client against fake server", () => {
  const envSnapshot = { ...process.env }

  before(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co"
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key"
    process.env.NETLIFY_SITE_ID = "fake-site-id"
    process.env.NETLIFY_TOKEN = "netlify-token"
    process.env.LOCAL_STORAGE_ROOT = "C:\\storage"
    process.env.REDIS_URL = "redis://127.0.0.1:6379"
    process.env.APP_PASSWORD = "password"
    process.env.SESSION_SECRET = "x".repeat(32)
    resetEnvCache()
    resetNetlifySiteUrlCache()
  })

  after(() => {
    process.env = envSnapshot
    resetEnvCache()
    resetNetlifySiteUrlCache()
  })

  it("creates a deploy, uploads required files, and waits for ready", async () => {
    const fake = await startNetlifyFake({ siteId: "fake-site-id" })
    process.env.NETLIFY_API_BASE = fake.url
    resetNetlifySiteUrlCache()

    const client = createNetlifyClient({ siteId: fake.siteId })
    const html = "<html>hello</html>"
    const robots = "User-agent: *\nDisallow: /\n"
    const files = {
      "/demo/lead/index.html": sha1(html),
      "/robots.txt": sha1(robots),
    }

    const deploy = await client.createDeploy(files, "pz test deploy")
    assert.ok(deploy.id)
    assert.deepEqual(deploy.required.sort(), Object.values(files).sort())

    const satisfied = new Set<string>()
    await client.uploadFile(deploy.id, "/demo/lead/index.html", Buffer.from(html), satisfied)
    await client.uploadFile(deploy.id, "/robots.txt", Buffer.from(robots), satisfied)

    await client.waitForReady(deploy.id, 10_000)
    assert.equal(await client.getSiteUrl(), fake.sslUrl)

    const paths = await client.listSiteFiles()
    assert.ok(paths)
    assert.deepEqual(paths.sort(), ["/demo/lead/index.html", "/robots.txt"].sort())

    await fake.close()
  })

  it("retries a 404 on the first deploy GET", async () => {
    const fake = await startNetlifyFake({ siteId: "fake-site-id" })
    fake.setFailFirstDeployGet(true)
    process.env.NETLIFY_API_BASE = fake.url
    resetNetlifySiteUrlCache()

    const client = createNetlifyClient({ siteId: fake.siteId })
    const body = "ready soon"
    const digest = sha1(body)
    const deploy = await client.createDeploy({ "/a/index.html": digest }, "retry get")
    const satisfied = new Set<string>()
    await client.uploadFile(deploy.id, "/a/index.html", Buffer.from(body), satisfied)
    await client.waitForReady(deploy.id, 10_000)

    await fake.close()
  })

  it("tolerates duplicate digest uploads within one deploy", async () => {
    const fake = await startNetlifyFake({ siteId: "fake-site-id" })
    process.env.NETLIFY_API_BASE = fake.url
    resetNetlifySiteUrlCache()

    const client = createNetlifyClient({ siteId: fake.siteId })
    const shared = "<html>same</html>"
    const digest = sha1(shared)
    const deploy = await client.createDeploy(
      {
        "/a/index.html": digest,
        "/b/index.html": digest,
      },
      "duplicate digest",
    )
    const satisfied = new Set<string>()
    await client.uploadFile(deploy.id, "/a/index.html", Buffer.from(shared), satisfied)
    await client.uploadFile(deploy.id, "/b/index.html", Buffer.from(shared), satisfied)
    await client.waitForReady(deploy.id, 10_000)

    await fake.close()
  })

  it("returns null for malformed /files responses", async () => {
    const fake = await startNetlifyFake({ siteId: "fake-site-id" })
    fake.setMalformedFilesResponse(true)
    process.env.NETLIFY_API_BASE = fake.url
    resetNetlifySiteUrlCache()

    const client = createNetlifyClient({ siteId: fake.siteId })
    assert.equal(await client.listSiteFiles(), null)

    await fake.close()
  })

  it("fails immediately on non-retryable 4xx during upload", async () => {
    const fake = await startNetlifyFake({ siteId: "fake-site-id" })
    process.env.NETLIFY_API_BASE = fake.url
    resetNetlifySiteUrlCache()

    const client = createNetlifyClient({ siteId: fake.siteId })
    await assert.rejects(
      client.uploadFile("missing-deploy", "/x/index.html", Buffer.from("x"), new Set()),
      (error: unknown) => error instanceof NetlifyError && error.status === 404,
    )

    await fake.close()
  })

  it("counts one PUT when redeploying 100 pages with one changed digest", async () => {
    const fake = await startNetlifyFake({ siteId: "fake-site-id" })
    process.env.NETLIFY_API_BASE = fake.url
    resetNetlifySiteUrlCache()

    const client = createNetlifyClient({ siteId: fake.siteId })
    const files: Record<string, string> = {
      "/robots.txt": sha1("User-agent: *\nDisallow: /\n"),
    }
    for (let i = 0; i < 100; i += 1) {
      const html = `<html>page ${i}</html>`
      files[`/batch/lead-${i}/index.html`] = sha1(html)
    }

    const first = await client.createDeploy(files, "seed")
    const satisfied = new Set<string>()
    for (const [path, digest] of Object.entries(files)) {
      const bytes =
        path === "/robots.txt"
          ? Buffer.from("User-agent: *\nDisallow: /\n")
          : Buffer.from(`<html>page ${path.match(/lead-(\d+)/)?.[1]}</html>`)
      assert.equal(sha1(bytes.toString()), digest)
      await client.uploadFile(first.id, path, bytes, satisfied)
    }
    await client.waitForReady(first.id, 30_000)

    fake.resetPutCount()
    files["/batch/lead-42/index.html"] = sha1("<html>changed</html>")
    const second = await client.createDeploy(files, "one change")
    assert.deepEqual(second.required, [files["/batch/lead-42/index.html"]])
    await client.uploadFile(
      second.id,
      "/batch/lead-42/index.html",
      Buffer.from("<html>changed</html>"),
      new Set(),
    )
    await client.waitForReady(second.id, 30_000)
    assert.equal(fake.putCount, 1)

    await fake.close()
  })
})

describe("normalizeSiteFilePath", () => {
  it("leaves an already-rooted path alone", () => {
    assert.equal(
      normalizeSiteFilePath("/acme/lead-1/index.html"),
      "/acme/lead-1/index.html",
    )
  })

  it("roots a path Netlify reports without a leading slash", () => {
    assert.equal(
      normalizeSiteFilePath("acme/lead-1/index.html"),
      "/acme/lead-1/index.html",
    )
  })

  it("collapses repeated leading slashes", () => {
    assert.equal(normalizeSiteFilePath("///robots.txt"), "/robots.txt")
  })

  it("agrees with manifest keys either way (the removal-guard invariant)", () => {
    const manifestKey = "/acme/lead-1/index.html"
    assert.equal(normalizeSiteFilePath(manifestKey), manifestKey)
    assert.equal(normalizeSiteFilePath(manifestKey.slice(1)), manifestKey)
  })
})
