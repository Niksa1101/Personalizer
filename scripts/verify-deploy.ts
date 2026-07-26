/**
 * Phase 11 deploy verification — hermetic fake Netlify leg (default) plus an
 * optional scratch-site real leg (`DEPLOY_REAL=1`).
 */

import { notFoundHtml } from "@/lib/not-found-page"
import { assertEnvOrExit } from "@/lib/env-node"
import { getRedis, manifestCacheKey } from "@/lib/queue"
import { robotsTxtBody } from "@/lib/robots-txt"
import { startNetlifyFake } from "@/scripts/fixtures/netlify-fake"
import { acquireDeployLock } from "@/worker/deploy/lock"
import {
  buildManifest,
  detectMassRemoval,
  diffPaths,
  ManifestDuplicatePathError,
  sha1Hex,
  type ManifestBuildResult,
  type ManifestSourceRow,
} from "@/worker/deploy/manifest"
import {
  createNetlifyClient,
  resetNetlifySiteUrlCache,
  validateNetlifyApiBase,
  type NetlifyClient,
} from "@/worker/deploy/netlify"
import {
  publishManifest,
  totalManifestBytes,
  type PublishManifestResult,
} from "@/worker/deploy/sync"
import { resolvePreviousManifestPaths } from "@/worker/steps/deploy"

interface CheckResult {
  name: string
  ok: boolean
  detail: string
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"])
const DEPLOY_BUDGET_MS = 120_000

const results: CheckResult[] = []

function pass(name: string, detail = "ok"): void {
  results.push({ name, ok: true, detail })
  console.log(`PASS  ${name}${detail === "ok" ? "" : ` — ${detail}`}`)
}

function fail(name: string, detail: string): void {
  results.push({ name, ok: false, detail })
  console.error(`FAIL  ${name} — ${detail}`)
}

function manifestPage(
  path: string,
  html: string,
  ref?: string,
): ManifestSourceRow {
  return {
    path,
    html,
    content_sha1: sha1Hex(html),
    source: "landing_pages",
    ref,
  }
}

function manifestRetained(
  path: string,
  html: string,
  ref?: string,
): ManifestSourceRow {
  return {
    path,
    html,
    content_sha1: sha1Hex(html),
    source: "retained_pages",
    ref,
  }
}

function fixturePageHtml(label: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${label}</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #1c1917; color: #fafaf9; font: 15px/1.55 sans-serif; }
</style>
</head>
<body><p>${label}</p></body>
</html>`
}

function setupHermeticEnv(siteId: string): void {
  process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://example.supabase.co"
  process.env.SUPABASE_SERVICE_ROLE_KEY ??= "service-role-key"
  process.env.NETLIFY_SITE_ID = siteId
  process.env.NETLIFY_TOKEN ??= "netlify-token"
  process.env.LOCAL_STORAGE_ROOT ??= "C:\\storage"
  process.env.REDIS_URL ??= "redis://127.0.0.1:6379"
  process.env.APP_PASSWORD ??= "password"
  process.env.SESSION_SECRET ??= "x".repeat(32)
}

function assertHermeticLoopbackGuard(): boolean {
  const raw = process.env.NETLIFY_API_BASE?.trim()
  if (!raw) {
    pass("hermetic loopback guard", "unset — will bind fake server")
    return true
  }

  try {
    const base = validateNetlifyApiBase(raw)
    const hostname = new URL(base).hostname
    if (!LOOPBACK_HOSTS.has(hostname)) {
      fail(
        "hermetic loopback guard",
        `NETLIFY_API_BASE must be loopback, got ${base}`,
      )
      return false
    }
    pass("hermetic loopback guard", base)
    return true
  } catch (error) {
    fail(
      "hermetic loopback guard",
      error instanceof Error ? error.message : String(error),
    )
    return false
  }
}

function assertRejectsRemoteApiBase(): void {
  try {
    validateNetlifyApiBase("http://api.example.com/v1")
    fail("client rejects remote http base", "expected throw")
  } catch (error) {
    if (error instanceof Error && /must be https or loopback/.test(error.message)) {
      pass("client rejects remote http base")
    } else {
      fail(
        "client rejects remote http base",
        error instanceof Error ? error.message : String(error),
      )
    }
  }
}

type FakeRedis = {
  set: (
    key: string,
    value: string,
    mode?: string,
    ttl?: number,
    nx?: string,
  ) => Promise<string | null>
  get: (key: string) => Promise<string | null>
  eval: (
    script: string,
    numKeys: number,
    key: string,
    ...args: string[]
  ) => Promise<number>
}

function createFakeRedis(): FakeRedis {
  const values = new Map<string, string>()

  return {
    async set(key, value, mode, _ttl, nx) {
      if (nx === "NX" && values.has(key)) {
        return null
      }
      values.set(key, value)
      return "OK"
    },
    async get(key) {
      return values.get(key) ?? null
    },
    // Dispatch on the script, not the argument count — the real lock passes a
    // TTL only to the renew script, and inferring intent from arity would keep
    // passing if those two scripts were ever swapped.
    async eval(script, _numKeys, key, token, ttlMs) {
      const current = values.get(key)
      if (current !== token) return 0

      if (script.includes("pexpire")) {
        if (ttlMs == null) throw new Error("renew script called without a TTL")
        return 1
      }
      if (script.includes("del")) {
        values.delete(key)
        return 1
      }
      throw new Error(`unexpected lock script: ${script.trim().slice(0, 40)}`)
    },
  }
}

/**
 * Drives the *production* publish path. `pages: []` keeps it hermetic —
 * markLandingPagesUploading() returns early on an empty list — and an explicit
 * budget skips the settings lookup, so no Supabase call is made.
 */
async function deployManifest(
  client: NetlifyClient,
  manifest: ManifestBuildResult,
  title: string,
): Promise<PublishManifestResult> {
  return publishManifest({
    manifest,
    pages: [],
    title,
    client,
    budgetMs: DEPLOY_BUDGET_MS,
  })
}

async function runHermeticLeg(): Promise<void> {
  console.log("\n=== Hermetic leg (fake Netlify) ===\n")

  assertRejectsRemoteApiBase()
  if (!assertHermeticLoopbackGuard()) {
    return
  }

  const fake = await startNetlifyFake({ siteId: "verify-deploy-fake" })
  setupHermeticEnv(fake.siteId)
  process.env.NETLIFY_API_BASE = fake.url
  resetNetlifySiteUrlCache()

  try {
    const client = createNetlifyClient({ siteId: fake.siteId })

    const empty = buildManifest({ pages: [], retained: [] })
    if (
      empty.files["/robots.txt"] === sha1Hex(robotsTxtBody()) &&
      empty.files["/404.html"] === sha1Hex(notFoundHtml()) &&
      Object.keys(empty.files).length === 2
    ) {
      pass("manifest includes robots.txt and 404.html")
    } else {
      fail(
        "manifest includes robots.txt and 404.html",
        `got ${Object.keys(empty.files).join(", ")}`,
      )
    }

    const liveHtml = "<html>live</html>"
    const retainedHtml = "<html>retained</html>"
    const collision = buildManifest({
      pages: [manifestPage("/demo/acme", liveHtml, "LP-1")],
      retained: [manifestRetained("/demo/acme", retainedHtml, "RP-1")],
    })
    if (
      collision.stats.deleteRetainedPaths.includes("/demo/acme") &&
      collision.files["/demo/acme/index.html"] === sha1Hex(liveHtml)
    ) {
      pass("D32 live wins over retained collision")
    } else {
      fail("D32 live wins over retained collision", "unexpected collision result")
    }

    try {
      buildManifest({
        pages: [
          manifestPage("/dup/a", "<html>a</html>", "LP-1"),
          manifestPage("/dup/a", "<html>b</html>", "LP-2"),
        ],
        retained: [],
      })
      fail("duplicate manifest path throws", "expected ManifestDuplicatePathError")
    } catch (error) {
      if (error instanceof ManifestDuplicatePathError) {
        pass("duplicate manifest path throws", error.manifestPath)
      } else {
        fail(
          "duplicate manifest path throws",
          error instanceof Error ? error.message : String(error),
        )
      }
    }

    // What runDryRunDeploy() does after ensureFreshLandingPage: assemble the
    // manifest, measure it, log it, return. Everything here is what the dry-run
    // branch runs; the Netlify client is constructed only on the other branch.
    // The end-to-end assertion (a lead reaching deployed_dry_run=true with a
    // null netlify_url) needs Supabase and is covered by the production run.
    fake.resetRequestCount()
    const dryRun = buildManifest({
      pages: [manifestPage("/dry-run/demo", fixturePageHtml("dry-run"))],
      retained: [],
    })
    const dryRunBytes = totalManifestBytes(dryRun)
    if (fake.requestCount === 0 && dryRunBytes > 0) {
      pass(
        "dry-run manifest assembly makes zero HTTP calls",
        `${Object.keys(dryRun.files).length} files, ${dryRunBytes} bytes`,
      )
    } else {
      fail(
        "dry-run manifest assembly makes zero HTTP calls",
        `${fake.requestCount} request(s), ${dryRunBytes} bytes`,
      )
    }

    const pageA = manifestPage("/verify/a", fixturePageHtml("page A"))
    const pageB = manifestPage("/verify/b", fixturePageHtml("page B"))
    const initial = buildManifest({ pages: [pageA, pageB], retained: [] })
    await deployManifest(client, initial, "verify initial")
    const livePaths = fake.getSiteFiles().map((file) => file.path).sort()
    if (
      livePaths.includes("/verify/a/index.html") &&
      livePaths.includes("/verify/b/index.html")
    ) {
      pass("initial deploy publishes fixture pages")
    } else {
      fail("initial deploy publishes fixture pages", livePaths.join(", "))
    }

    const trimmed = buildManifest({ pages: [pageA], retained: [] })
    await deployManifest(client, trimmed, "verify unpublish")
    const afterUnpublish = fake.getSiteFiles().map((file) => file.path)
    if (
      afterUnpublish.includes("/verify/a/index.html") &&
      !afterUnpublish.includes("/verify/b/index.html")
    ) {
      pass("unpublish-by-omission removes omitted paths")
    } else {
      fail(
        "unpublish-by-omission removes omitted paths",
        afterUnpublish.join(", "),
      )
    }

    const batchPages = Array.from({ length: 100 }, (_, i) =>
      manifestPage(`/batch/lead-${i}`, `<html>page ${i}</html>`, `LP-${i}`),
    )
    await deployManifest(
      client,
      buildManifest({ pages: batchPages, retained: [] }),
      "verify batch seed",
    )

    fake.resetPutCount()
    const changedPages = batchPages.map((page, i) =>
      i === 42 ? manifestPage(page.path, "<html>changed</html>", page.ref) : page,
    )
    const changed = await deployManifest(
      client,
      buildManifest({ pages: changedPages, retained: [] }),
      "verify one change",
    )
    if (fake.putCount === 1 && changed.uploadedCount === 1) {
      pass(
        "100 pages / 1 change → exactly one PUT",
        `required=${changed.requiredCount} uploaded=${changed.uploadedCount}`,
      )
    } else {
      fail(
        "100 pages / 1 change → exactly one PUT",
        `putCount=${fake.putCount} uploaded=${changed.uploadedCount} required=${changed.requiredCount}`,
      )
    }

    // D34 — two paths sharing one digest are two uploads, not one.
    fake.resetPutCount()
    const twinHtml = "<html>identical twins</html>"
    const twinManifest = buildManifest({
      pages: [
        ...changedPages,
        manifestPage("/batch/twin-a", twinHtml, "LP-TA"),
        manifestPage("/batch/twin-b", twinHtml, "LP-TB"),
      ],
      retained: [],
    })
    const twins = await deployManifest(
      client,
      twinManifest,
      "verify duplicate digests",
    )
    if (fake.putCount === 2 && twins.requiredCount === 1) {
      pass("D34 duplicate digest uploads once per path", "2 PUTs, 1 digest")
    } else {
      fail(
        "D34 duplicate digest uploads once per path",
        `putCount=${fake.putCount} required=${twins.requiredCount}`,
      )
    }

    fake.setMalformedFilesResponse(true)
    const malformed = await client.listSiteFiles()
    const unknownPrevious = await resolvePreviousManifestPaths(client, null)
    fake.setMalformedFilesResponse(false)
    if (malformed === null && unknownPrevious.source === "unknown") {
      pass("malformed /files degrades to previous_paths: unknown")
    } else {
      fail(
        "malformed /files degrades to previous_paths: unknown",
        `listSiteFiles=${String(malformed)} source=${unknownPrevious.source}`,
      )
    }

    // The guard's own input: resolvePreviousManifestPaths() as the deploy step
    // calls it. Cold cache seeds from the live site listing, and the seeded
    // paths must be directly comparable to manifest keys — an unnormalized
    // leading slash here reads as "everything was removed".
    // Compared against the manifest that is actually live right now (the twins
    // deploy) — re-deploying the same desired state must show zero removals.
    const seeded = await resolvePreviousManifestPaths(client, null)
    if (seeded.source === "seed" && seeded.paths) {
      const seededDiff = diffPaths(
        seeded.paths,
        Object.keys(twinManifest.files).sort(),
      )
      const rooted = seeded.paths.every((path) => path.startsWith("/"))
      if (rooted && seededDiff.removed.length === 0) {
        pass(
          "removal guard seeds from live site and sees no phantom removals",
          `${seeded.paths.length} paths`,
        )
      } else {
        fail(
          "removal guard seeds from live site and sees no phantom removals",
          `rooted=${rooted} removed=${seededDiff.removed.length}`,
        )
      }
    } else {
      fail(
        "removal guard seeds from live site and sees no phantom removals",
        `source=${seeded.source}`,
      )
    }

    // The guard fires on a real removal: the previous set is what was live
    // before the unpublish deploy, the current set is what the manifest holds.
    const guardDiff = diffPaths(
      Object.keys(initial.files).sort(),
      Object.keys(trimmed.files).sort(),
    )
    if (guardDiff.removed.length === 1 && guardDiff.removed[0] === "/verify/b/index.html") {
      pass("removal guard detects the unpublished path", guardDiff.removed[0])
    } else {
      fail(
        "removal guard detects the unpublished path",
        `removed=${JSON.stringify(guardDiff.removed)}`,
      )
    }

    // The mass-removal floor: a truncated manifest read looks exactly like a
    // mass delete, and must be refused rather than published.
    const massPrevious = Array.from(
      { length: 60 },
      (_, i) => `/mass/lead-${i}/index.html`,
    )
    const massBlocked = detectMassRemoval({
      previousPaths: massPrevious,
      currentPaths: massPrevious.slice(0, 5),
    })
    const massAllowed = detectMassRemoval({
      previousPaths: massPrevious,
      currentPaths: massPrevious.slice(0, 59),
    })
    if (massBlocked.blocked && !massAllowed.blocked) {
      pass(
        "mass-removal floor blocks a truncated manifest",
        `${massBlocked.removedCount}/${massBlocked.previousCount} refused`,
      )
    } else {
      fail(
        "mass-removal floor blocks a truncated manifest",
        `blocked=${massBlocked.blocked} allowed=${massAllowed.blocked}`,
      )
    }

    const redis = createFakeRedis()
    const siteId = "verify-deploy-lock"
    const firstPromise = acquireDeployLock({
      siteId,
      redis: redis as never,
      waitMs: 5_000,
    })
    let secondError: unknown = null
    const secondPromise = acquireDeployLock({
      siteId,
      redis: redis as never,
      waitMs: 250,
    }).catch((error: unknown) => {
      secondError = error
    })
    const first = await firstPromise
    await secondPromise
    if (secondError instanceof Error && /Timed out waiting for deploy lock/.test(secondError.message)) {
      pass("deploy lock serializes concurrent acquires")
    } else {
      fail(
        "deploy lock serializes concurrent acquires",
        secondError instanceof Error ? secondError.message : "second acquire succeeded early",
      )
    }
    await first.release()
    const second = await acquireDeployLock({
      siteId,
      redis: redis as never,
      waitMs: 5_000,
    })
    await second.release()
  } catch (error) {
    fail(
      "hermetic leg",
      error instanceof Error ? error.message : String(error),
    )
  } finally {
    await fake.close().catch(() => undefined)
    delete process.env.NETLIFY_API_BASE
    resetNetlifySiteUrlCache()
  }
}

async function fetchPageStatus(url: string): Promise<{ status: number; noindex: boolean }> {
  const response = await fetch(url, { redirect: "follow" })
  const html = await response.text()
  const noindex = /<meta[^>]+name=["']robots["'][^>]+content=["'][^"']*noindex/i.test(html)
  return { status: response.status, noindex }
}

async function runRealLeg(): Promise<void> {
  if (process.env.DEPLOY_REAL !== "1") {
    console.log("\n=== Real leg skipped (set DEPLOY_REAL=1 to run) ===\n")
    return
  }

  console.log("\n=== Real leg (scratch Netlify site) ===\n")

  const testSiteId = process.env.NETLIFY_TEST_SITE_ID?.trim()
  if (!testSiteId) {
    fail("real leg NETLIFY_TEST_SITE_ID", "missing — scratch site id required")
    return
  }

  assertEnvOrExit()
  resetNetlifySiteUrlCache()

  const client = createNetlifyClient({ siteId: testSiteId })
  const runId = Date.now().toString(36)
  const pageAPath = `/verify-deploy-${runId}/fixture-a`
  const pageBPath = `/verify-deploy-${runId}/fixture-b`

  const fixtureManifest = buildManifest({
    pages: [
      manifestPage(pageAPath, fixturePageHtml("fixture A"), "VF-A"),
      manifestPage(pageBPath, fixturePageHtml("fixture B"), "VF-B"),
    ],
    retained: [],
  })

  try {
    await deployManifest(client, fixtureManifest, `verify:deploy seed ${runId}`)
    const siteUrl = (await client.getSiteUrl()).replace(/\/$/, "")

    const pageA = await fetchPageStatus(`${siteUrl}${pageAPath}`)
    const pageB = await fetchPageStatus(`${siteUrl}${pageBPath}`)
    if (pageA.status === 200 && pageA.noindex) {
      pass("real fixture A live with noindex", `${siteUrl}${pageAPath}`)
    } else {
      fail("real fixture A live with noindex", `status=${pageA.status} noindex=${pageA.noindex}`)
    }
    if (pageB.status === 200 && pageB.noindex) {
      pass("real fixture B live with noindex", `${siteUrl}${pageBPath}`)
    } else {
      fail("real fixture B live with noindex", `status=${pageB.status} noindex=${pageB.noindex}`)
    }

    await getRedis().del(manifestCacheKey(testSiteId))
    const seededPrevious = await resolvePreviousManifestPaths(client, null)
    if (seededPrevious.source !== "seed" || !seededPrevious.paths) {
      fail(
        "D86 cold-cache seed from listSiteFiles",
        `source=${seededPrevious.source}`,
      )
    } else {
      const seededSet = new Set(seededPrevious.paths)
      if (
        seededSet.has(`${pageAPath}/index.html`) &&
        seededSet.has(`${pageBPath}/index.html`)
      ) {
        pass(
          "D86 cold-cache seed from listSiteFiles",
          `${seededPrevious.paths.length} paths`,
        )
      } else {
        fail(
          "D86 cold-cache seed from listSiteFiles",
          "fixture paths missing from seeded set",
        )
      }
    }

    // Redeploying the identical manifest against the seeded previous set must
    // be a no-op upload: Netlify already holds every digest.
    const reseed = await deployManifest(
      client,
      fixtureManifest,
      `verify:deploy reseed ${runId}`,
    )
    if (reseed.requiredCount === 0 && reseed.uploadedCount === 0) {
      pass(
        "redeploy after cache delete uploads nothing",
        `required=${reseed.requiredCount}`,
      )
    } else {
      fail(
        "redeploy after cache delete uploads nothing",
        `required=${reseed.requiredCount} uploaded=${reseed.uploadedCount}`,
      )
    }

    // The seeded paths must be shaped like manifest keys, or the removal guard
    // would read every path as removed on any cold cache.
    if (seededPrevious.paths?.every((path) => path.startsWith("/"))) {
      pass("live /files paths are rooted and comparable to manifest keys")
    } else {
      fail(
        "live /files paths are rooted and comparable to manifest keys",
        `sample=${JSON.stringify(seededPrevious.paths?.slice(0, 3))}`,
      )
    }

    const teardown = buildManifest({ pages: [], retained: [] })
    if (
      Object.keys(teardown.files).length === 2 &&
      teardown.files["/robots.txt"] &&
      teardown.files["/404.html"]
    ) {
      pass("teardown manifest is production buildManifest() with zero pages")
    } else {
      fail("teardown manifest is production buildManifest() with zero pages", "unexpected files")
    }

    await deployManifest(client, teardown, `verify:deploy teardown ${runId}`)

    const afterA = await fetchPageStatus(`${siteUrl}${pageAPath}`)
    const afterB = await fetchPageStatus(`${siteUrl}${pageBPath}`)
    const robots = await fetch(`${siteUrl}/robots.txt`)
    const robotsBody = await robots.text()

    if (afterA.status === 404 && afterB.status === 404) {
      pass("teardown fixture pages return 404")
    } else {
      fail(
        "teardown fixture pages return 404",
        `A=${afterA.status} B=${afterB.status}`,
      )
    }

    if (robots.status === 200 && robotsBody.includes("Disallow: /")) {
      pass("teardown leaves robots.txt 200 with Disallow: /")
    } else {
      fail(
        "teardown leaves robots.txt 200 with Disallow: /",
        `status=${robots.status} body=${robotsBody.slice(0, 80)}`,
      )
    }
  } catch (error) {
    fail(
      "real leg",
      error instanceof Error ? error.message : String(error),
    )
  } finally {
    resetNetlifySiteUrlCache()
  }
}

async function main(): Promise<void> {
  await runHermeticLeg()
  await runRealLeg()

  const failed = results.filter((result) => !result.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)

  if (failed.length > 0) {
    process.exit(1)
  }
}

main().catch((error) => {
  console.error("verify:deploy fatal:", error)
  process.exit(1)
})
