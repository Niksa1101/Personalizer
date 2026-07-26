import { strict as assert } from "node:assert"
import { describe, it } from "node:test"

import { notFoundHtml } from "./not-found-page"

describe("notFoundHtml", () => {
  const html = notFoundHtml()

  it("is self-contained with inline dark styling and noindex", () => {
    assert.match(html, /<!doctype html>/i)
    assert.match(html, /<style>[\s\S]*<\/style>/)
    assert.match(html, /noindex, nofollow/)
    assert.match(html, /background:\s*#1c1917/)
    assert.doesNotMatch(html, /https?:\/\//)
  })

  it("shows one line of text with no links or branding", () => {
    assert.match(html, /<p>Page not found\.<\/p>/)
    assert.doesNotMatch(html, /<a\b/)
  })
})
