import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { quotePostgrestValue } from "@/lib/lead-filters"
import { buildLogCursorFilter, shouldFilterLevels } from "@/lib/log-query"

describe("buildLogCursorFilter", () => {
  it("quotes both created_at values", () => {
    const filter = buildLogCursorFilter({
      createdAt: "2026-07-28T12:00:00.000Z",
      id: 9,
    })
    const quoted = quotePostgrestValue("2026-07-28T12:00:00.000Z")
    assert.match(filter, new RegExp(`created_at\\.lt\\.${quoted.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`))
    assert.match(filter, new RegExp(`created_at\\.eq\\.${quoted.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`))
  })

  it("survives special characters via quotePostgrestValue", () => {
    const createdAt = '2026-07-28T12:00:00.000Z",evil'
    const filter = buildLogCursorFilter({ createdAt, id: 1 })
    assert.match(filter, /created_at\.lt\."2026-07-28T12:00:00\.000Z\\",evil"/)
  })
})

describe("shouldFilterLevels", () => {
  it("returns all, some, and empty correctly", () => {
    assert.equal(shouldFilterLevels(["debug", "info", "warn", "error"]), "all")
    assert.equal(shouldFilterLevels(["warn"]), "some")
    assert.equal(shouldFilterLevels([]), "empty")
  })
})
