import { describe, it } from "node:test"
import assert from "node:assert/strict"

import {
  isSocialOrDirectory,
  normalizeWebsiteUrl,
  skippedRequeueBlockReason,
} from "@/lib/website-url"

describe("normalizeWebsiteUrl", () => {
  it("normalizes bare hosts", () => {
    const url = normalizeWebsiteUrl("example.com")
    assert.equal(url, "https://example.com")
  })

  it("strips trailing slash on bare host", () => {
    assert.equal(normalizeWebsiteUrl("example.com/"), "https://example.com")
  })

  it("preserves path", () => {
    assert.equal(
      normalizeWebsiteUrl("acme.com/about/"),
      "https://acme.com/about/",
    )
  })

  it("returns null for invalid input", () => {
    assert.equal(normalizeWebsiteUrl(":::bad"), null)
  })
})

describe("isSocialOrDirectory", () => {
  it("detects facebook", () => {
    assert.equal(isSocialOrDirectory("https://facebook.com/acme"), true)
  })

  it("detects yelp", () => {
    assert.equal(isSocialOrDirectory("https://www.yelp.com/biz/acme"), true)
  })

  it("allows real websites", () => {
    assert.equal(isSocialOrDirectory("https://www.acme-plumbing.com"), false)
  })
})

describe("skippedRequeueBlockReason", () => {
  it("blocks empty website URLs", () => {
    assert.equal(skippedRequeueBlockReason(null), "Add a website URL first")
    assert.equal(skippedRequeueBlockReason("  "), "Add a website URL first")
  })

  it("blocks social profiles", () => {
    assert.match(
      skippedRequeueBlockReason("https://facebook.com/acme") ?? "",
      /social profile/,
    )
  })

  it("allows valid websites", () => {
    assert.equal(
      skippedRequeueBlockReason("https://www.acme-plumbing.com"),
      null,
    )
  })
})
