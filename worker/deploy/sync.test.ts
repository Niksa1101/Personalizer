import { strict as assert } from "node:assert"
import { createHash } from "node:crypto"
import { describe, it } from "node:test"

import { planUploads } from "@/worker/deploy/sync"

function sha1(text: string): string {
  return createHash("sha1").update(text, "utf8").digest("hex")
}

describe("planUploads", () => {
  it("uploads only the paths whose digest Netlify asked for", () => {
    const files: Record<string, string> = {
      "/robots.txt": sha1("robots"),
      "/404.html": sha1("404"),
    }
    for (let i = 0; i < 100; i += 1) {
      files[`/batch/lead-${i}/index.html`] = sha1(`page ${i}`)
    }

    const changed = sha1("page 42 changed")
    files["/batch/lead-42/index.html"] = changed

    assert.deepEqual(planUploads(files, [changed]), [
      "/batch/lead-42/index.html",
    ])
  })

  it("uploads every path sharing a required digest (D34)", () => {
    const shared = sha1("<html>identical</html>")
    const files = {
      "/campaign/lead-a/index.html": shared,
      "/campaign/lead-b/index.html": shared,
      "/campaign/lead-c/index.html": sha1("<html>other</html>"),
    }

    assert.deepEqual(planUploads(files, [shared]), [
      "/campaign/lead-a/index.html",
      "/campaign/lead-b/index.html",
    ])
  })

  it("uploads nothing when Netlify already has every digest", () => {
    const files = {
      "/robots.txt": sha1("robots"),
      "/campaign/lead-a/index.html": sha1("<html>a</html>"),
    }

    assert.deepEqual(planUploads(files, []), [])
  })

  it("treats site files by the same rule as landing pages", () => {
    const robots = sha1("User-agent: *\nDisallow: /\n")
    const files = {
      "/robots.txt": robots,
      "/404.html": sha1("<html>404</html>"),
      "/campaign/lead-a/index.html": sha1("<html>a</html>"),
    }

    assert.deepEqual(planUploads(files, [robots]), ["/robots.txt"])
  })

  it("returns paths sorted for deterministic upload order", () => {
    const digest = sha1("same")
    const files = {
      "/z/index.html": digest,
      "/a/index.html": digest,
      "/m/index.html": digest,
    }

    assert.deepEqual(planUploads(files, [digest]), [
      "/a/index.html",
      "/m/index.html",
      "/z/index.html",
    ])
  })

  it("ignores required digests that are not in the manifest", () => {
    const present = sha1("<html>a</html>")
    const files = { "/campaign/lead-a/index.html": present }

    assert.deepEqual(planUploads(files, [present, sha1("stale")]), [
      "/campaign/lead-a/index.html",
    ])
  })
})
