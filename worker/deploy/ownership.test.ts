import { strict as assert } from "node:assert"
import { describe, it } from "node:test"

import {
  assertSiteOwnership,
  classifySiteFiles,
  classifySitePath,
  SiteOwnershipError,
  STRUCTURAL_PATHS,
} from "@/worker/deploy/ownership"

describe("classifySitePath", () => {
  const owned = new Set(["/demo/acme/index.html"])
  const adopted = new Set(["/legacy/page/index.html"])

  it("structural paths are always owned", () => {
    for (const path of STRUCTURAL_PATHS) {
      assert.equal(classifySitePath(path, new Set(), new Set()), "structural")
    }
  })

  it("row-matched paths are owned", () => {
    assert.equal(classifySitePath("/demo/acme/index.html", owned, new Set()), "owned")
  })

  it("adopted paths are owned", () => {
    assert.equal(
      classifySitePath("/legacy/page/index.html", new Set(), adopted),
      "owned",
    )
  })

  it("app-shaped rowless paths are orphaned, not foreign", () => {
    assert.equal(
      classifySitePath("/campaign/lead/index.html", new Set(), new Set()),
      "orphaned",
    )
  })

  it("genuinely foreign paths classify as foreign", () => {
    assert.equal(classifySitePath("/index.html", new Set(), new Set()), "foreign")
    assert.equal(classifySitePath("/assets/app.js", new Set(), new Set()), "foreign")
    assert.equal(classifySitePath("/favicon.ico", new Set(), new Set()), "foreign")
  })
})

describe("classifySiteFiles", () => {
  it("empty site listing yields no foreign paths", () => {
    const report = classifySiteFiles({
      sitePaths: [],
      ownedPaths: new Set(),
      adoptedPaths: new Set(),
    })
    assert.deepEqual(report.foreign, [])
    assert.deepEqual(report.orphaned, [])
    assert.equal(report.totalCount, 0)
  })

  it("partitions mixed paths correctly", () => {
    const report = classifySiteFiles({
      sitePaths: [
        "/robots.txt",
        "/demo/acme/index.html",
        "/orphan/lead/index.html",
        "/assets/app.js",
        "/favicon.ico",
      ],
      ownedPaths: new Set(["/demo/acme/index.html"]),
      adoptedPaths: new Set(),
    })
    assert.deepEqual(report.foreign, ["/assets/app.js", "/favicon.ico"])
    assert.deepEqual(report.orphaned, ["/orphan/lead/index.html"])
    assert.equal(report.ownedCount, 2)
    assert.equal(report.totalCount, 5)
  })
})

describe("assertSiteOwnership", () => {
  it("skips on warm cache without listing site files", async () => {
    let listed = false
    await assertSiteOwnership({
      siteId: "test-site",
      client: {
        listSiteFiles: async () => {
          listed = true
          return ["/assets/app.js"]
        },
      },
      cachedPaths: ["/robots.txt", "/demo/acme/index.html"],
    })
    assert.equal(listed, false)
  })

  it("passes on empty site listing", async () => {
    await assertSiteOwnership({
      siteId: "test-site",
      client: { listSiteFiles: async () => [] },
      cachedPaths: null,
    })
  })
})

describe("SiteOwnershipError", () => {
  it("carries a readable sample and adoption hint", () => {
    const error = new SiteOwnershipError("site-1", [
      "/assets/app.js",
      "/favicon.ico",
    ])
    assert.match(error.message, /Refusing to deploy/)
    assert.match(error.message, /npm run adopt:site/)
    assert.equal(error.foreignCount, 2)
    assert.deepEqual(error.sample, ["/assets/app.js", "/favicon.ico"])
  })
})
