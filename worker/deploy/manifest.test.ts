import { strict as assert } from "node:assert"
import { describe, it } from "node:test"

import { notFoundHtml } from "@/lib/not-found-page"
import { robotsTxtBody } from "@/lib/robots-txt"
import {
  buildManifest,
  detectMassRemoval,
  diffPaths,
  ManifestDuplicatePathError,
  manifestHash,
  sha1Hex,
} from "@/worker/deploy/manifest"

function page(
  path: string,
  html: string,
  ref?: string,
): {
  path: string
  html: string
  content_sha1: string
  source: string
  ref?: string
} {
  return {
    path,
    html,
    content_sha1: sha1Hex(html),
    source: "landing_pages",
    ref,
  }
}

function retained(
  path: string,
  html: string,
  ref?: string,
): {
  path: string
  html: string
  content_sha1: string
  source: string
  ref?: string
} {
  return {
    path,
    html,
    content_sha1: sha1Hex(html),
    source: "retained_pages",
    ref,
  }
}

describe("buildManifest", () => {
  it("includes site files even with zero pages", () => {
    const result = buildManifest({ pages: [], retained: [] })

    assert.equal(Object.keys(result.files).length, 2)
    assert.equal(result.files["/robots.txt"], sha1Hex(robotsTxtBody()))
    assert.equal(result.files["/404.html"], sha1Hex(notFoundHtml()))
    assert.equal(result.stats.pageCount, 0)
    assert.equal(result.stats.retainedCount, 0)
    assert.equal(result.stats.siteFileCount, 2)
  })

  it("maps landing paths to index.html digests", () => {
    const html = "<html>hello</html>"
    const result = buildManifest({
      pages: [page("/demo/acme", html, "LP-1")],
      retained: [],
    })

    assert.equal(result.files["/demo/acme/index.html"], sha1Hex(html))
    assert.equal(
      result.bytes["/demo/acme/index.html"]!.toString("utf8"),
      html,
    )
  })

  it("live wins over retained on path collision (D32)", () => {
    const liveHtml = "<html>live</html>"
    const retainedHtml = "<html>retained</html>"
    const result = buildManifest({
      pages: [page("/demo/acme", liveHtml, "LP-1")],
      retained: [retained("/demo/acme", retainedHtml, "RP-1")],
    })

    assert.equal(result.files["/demo/acme/index.html"], sha1Hex(liveHtml))
    assert.equal(result.stats.retainedCount, 0)
    assert.deepEqual(result.stats.deleteRetainedPaths, ["/demo/acme"])
    assert.equal(result.stats.collisions.length, 1)
    assert.match(result.stats.warnings[0]!, /live wins/)
    assert.equal(
      result.bytes["/demo/acme/index.html"]!.toString("utf8"),
      liveHtml,
    )
  })

  it("throws on duplicate manifest paths (D35)", () => {
    assert.throws(
      () =>
        buildManifest({
          pages: [
            page("/demo/a", "<html>a</html>", "LP-1"),
            page("/demo/a", "<html>b</html>", "LP-2"),
          ],
          retained: [],
        }),
      (error: unknown) => {
        assert.ok(error instanceof ManifestDuplicatePathError)
        assert.equal(error.manifestPath, "/demo/a/index.html")
        assert.match(error.message, /landing_pages \(LP-1\)/)
        assert.match(error.message, /landing_pages \(LP-2\)/)
        return true
      },
    )
  })

  it("repairs mismatched digests and uses the recomputed value (D11)", () => {
    const html = "<html>repair me</html>"
    const result = buildManifest({
      pages: [
        {
          path: "/demo/acme",
          html,
          content_sha1: "0".repeat(40),
          source: "landing_pages",
          ref: "LP-1",
        },
      ],
      retained: [],
    })

    assert.equal(result.files["/demo/acme/index.html"], sha1Hex(html))
    assert.equal(result.stats.repairs.length, 1)
    assert.equal(result.stats.repairs[0]!.computedSha1, sha1Hex(html))
    assert.equal(result.stats.repairs[0]!.storedSha1, "0".repeat(40))
  })
})

describe("manifestHash", () => {
  it("is stable for the same file map regardless of insertion order", () => {
    const filesA = {
      "/a/index.html": "aaa",
      "/robots.txt": "bbb",
      "/404.html": "ccc",
    }
    const filesB = {
      "/404.html": "ccc",
      "/a/index.html": "aaa",
      "/robots.txt": "bbb",
    }

    assert.equal(manifestHash(filesA), manifestHash(filesB))
  })

  it("changes when any digest changes", () => {
    const base = {
      "/a/index.html": "aaa",
      "/robots.txt": "bbb",
      "/404.html": "ccc",
    }
    const changed = {
      ...base,
      "/a/index.html": "zzz",
    }

    assert.notEqual(manifestHash(base), manifestHash(changed))
  })
})

describe("diffPaths", () => {
  it("computes added and removed paths", () => {
    const diff = diffPaths(
      ["/a/index.html", "/b/index.html", "/robots.txt"],
      ["/b/index.html", "/c/index.html", "/robots.txt", "/404.html"],
    )

    assert.deepEqual(diff.added, ["/404.html", "/c/index.html"])
    assert.deepEqual(diff.removed, ["/a/index.html"])
  })

  it("treats a missing previous set as empty", () => {
    const diff = diffPaths(null, ["/robots.txt"])
    assert.deepEqual(diff.added, ["/robots.txt"])
    assert.deepEqual(diff.removed, [])
  })
})

describe("detectMassRemoval", () => {
  const many = (n: number, prefix = "p") =>
    Array.from({ length: n }, (_, i) => `/${prefix}-${i}/index.html`)

  it("blocks a manifest that drops most of a large site", () => {
    const previous = many(100)
    const result = detectMassRemoval({
      previousPaths: previous,
      currentPaths: previous.slice(0, 10),
    })

    assert.equal(result.blocked, true)
    assert.equal(result.removedCount, 90)
    assert.equal(result.previousCount, 100)
  })

  it("allows an ordinary incremental removal", () => {
    const previous = many(100)
    const result = detectMassRemoval({
      previousPaths: previous,
      currentPaths: previous.slice(0, 99),
    })

    assert.equal(result.blocked, false)
    assert.equal(result.removedCount, 1)
  })

  it("exempts small sites where deleting most pages is ordinary", () => {
    const previous = many(3)
    const result = detectMassRemoval({
      previousPaths: previous,
      currentPaths: [],
    })

    assert.equal(result.blocked, false)
    assert.equal(result.removedCount, 3)
  })

  it("never blocks on a cold cache", () => {
    assert.equal(
      detectMassRemoval({ previousPaths: null, currentPaths: [] }).blocked,
      false,
    )
    assert.equal(
      detectMassRemoval({ previousPaths: undefined, currentPaths: many(5) })
        .blocked,
      false,
    )
  })

  it("allows exactly half to be removed, blocks past it", () => {
    const previous = many(20)
    assert.equal(
      detectMassRemoval({
        previousPaths: previous,
        currentPaths: previous.slice(0, 10),
      }).blocked,
      false,
    )
    assert.equal(
      detectMassRemoval({
        previousPaths: previous,
        currentPaths: previous.slice(0, 9),
      }).blocked,
      true,
    )
  })
})
