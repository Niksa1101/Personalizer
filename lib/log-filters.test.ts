import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  decodeLogCursor,
  describeInvalidLogParams,
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

describe("describeInvalidLogParams", () => {
  it("is silent for filters that return rows normally", () => {
    assert.deepEqual(
      describeInvalidLogParams(parseLogFilters({ preset: "24h" })),
      [],
    )
    assert.deepEqual(
      describeInvalidLogParams(parseLogFilters({ level: "warn,bogus" })),
      [],
    )
  })

  // Every filter listLogs short-circuits on must have a notice, or the screen
  // silently shows "No logs in the last 24 hours" for the wrong reason.
  it("explains a level param that matched nothing", () => {
    const notices = describeInvalidLogParams(parseLogFilters({ level: "bogus" }))
    assert.equal(notices.length, 1)
    assert.equal(notices[0]!.kind, "levels")
    assert.match(notices[0]!.actionLabel, /level/i)
  })

  it("explains a stale or tampered cursor", () => {
    const notices = describeInvalidLogParams(
      parseLogFilters({ cursor: "x') or (1=1--|1" }),
    )
    assert.equal(notices.length, 1)
    assert.equal(notices[0]!.kind, "cursor")
  })

  it("explains both when both are rejected", () => {
    const notices = describeInvalidLogParams(
      parseLogFilters({ level: "bogus", cursor: "garbage" }),
    )
    assert.deepEqual(
      notices.map((notice) => notice.kind),
      ["levels", "cursor"],
    )
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

  // An open-ended window that carried `to = now` clamped the query to the app
  // clock: rows the database wrote milliseconds ago sorted after the upper
  // bound and vanished from /logs, and the gap widened with clock skew.
  it("open-ended presets apply no upper bound", () => {
    for (const preset of ["1h", "24h", "7d", "30d", "all"] as const) {
      const window = resolveLogTimeWindow(parseLogFilters({ preset }))
      assert.equal(window.to, null, `${preset} should not bound the upper end`)
      assert.equal(window.openEnded, true)
    }
  })

  it("open-ended windows stay open with only from set", () => {
    const window = resolveLogTimeWindow(
      parseLogFilters({ from: "2026-01-01T00:00:00.000Z" }),
    )
    assert.equal(window.to, null)
    assert.equal(window.openEnded, true)
  })

  it("an explicit to closes the window", () => {
    const to = "2026-01-02T00:00:00.000Z"
    const window = resolveLogTimeWindow(
      parseLogFilters({ from: "2026-01-01T00:00:00.000Z", to }),
    )
    assert.equal(window.to?.toISOString(), to)
    assert.equal(window.openEnded, false)
  })

  it("an unparseable to is treated as absent, not as now", () => {
    const window = resolveLogTimeWindow(
      parseLogFilters({ from: "2026-01-01T00:00:00.000Z", to: "not-a-date" }),
    )
    assert.equal(window.to, null)
    assert.equal(window.openEnded, true)
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
