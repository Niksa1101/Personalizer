import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  decodeLogCursor,
  encodeLogCursor,
  LOG_LEVELS,
  parseLogFilters,
  resolveLogTimeWindow,
  serializeLogFilters,
} from "@/lib/log-filters"

describe("parseLevels via parseLogFilters", () => {
  it("bogus level keeps all LOG_LEVELS for UI but flags allInvalid", () => {
    const filters = parseLogFilters({ level: "bogus" })
    assert.deepEqual(filters.levels, [...LOG_LEVELS])
    assert.equal(filters.levelsAllInvalid, true)
  })

  it("filters unknown levels but keeps valid ones", () => {
    assert.deepEqual(parseLogFilters({ level: "warn,bogus,error" }).levels, [
      "warn",
      "error",
    ])
  })
})

describe("resolveLogTimeWindow", () => {
  it("from=not-a-date falls back to preset window", () => {
    const window = resolveLogTimeWindow(parseLogFilters({ from: "not-a-date" }))
    assert.equal(Number.isFinite(window.from.getTime()), true)
  })

  it("to=not-a-date falls back without throwing", () => {
    const window = resolveLogTimeWindow(
      parseLogFilters({ preset: "24h", to: "not-a-date" }),
    )
    assert.equal(Number.isFinite(window.from.getTime()), true)
  })
})

describe("decodeLogCursor", () => {
  it("rejects injection and malformed cursors", () => {
    assert.equal(decodeLogCursor("x') or (1=1--|1"), null)
    assert.equal(decodeLogCursor("2026-01-01|abc"), null)
    assert.equal(decodeLogCursor("2026-01-01T00:00:00.000Z|1.5"), null)
    assert.equal(decodeLogCursor("2026-01-01T00:00:00.000Z|-1"), null)
    assert.equal(decodeLogCursor("|1"), null)
    assert.equal(decodeLogCursor("not-a-date|1"), null)
  })

  it("round-trips encode/decode", () => {
    const cursor = {
      createdAt: "2026-07-28T12:00:00.000Z",
      id: 42,
    }
    assert.deepEqual(decodeLogCursor(encodeLogCursor(cursor)), cursor)
  })
})

describe("serialize/parse round-trip", () => {
  it("preserves filters", () => {
    const filters = parseLogFilters({
      preset: "7d",
      level: "warn,error",
      scope: "worker",
      lead: "LD-0042",
      q: "ffmpeg",
    })
    const params = serializeLogFilters(filters)
    const roundTripped = parseLogFilters(Object.fromEntries(params))
    assert.deepEqual(roundTripped.levels, filters.levels)
    assert.equal(roundTripped.scope, filters.scope)
    assert.equal(roundTripped.leadRef, filters.leadRef)
    assert.equal(roundTripped.search, filters.search)
    assert.equal(roundTripped.preset, filters.preset)
  })
})
