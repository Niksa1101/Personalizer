import { strict as assert } from "node:assert"
import { describe, it } from "node:test"

import {
  MIN_SCROLL_DURATION_MS,
  MAX_SCROLL_DURATION_MS,
  computeScrollPlan,
} from "./scroll"

describe("computeScrollPlan", () => {
  it("holds static pages for the minimum duration", () => {
    const plan = computeScrollPlan(1080, 1080, 800)
    assert.equal(plan.durationMs, MIN_SCROLL_DURATION_MS)
    assert.equal(plan.scrollDistancePx, 0)
  })

  it("clamps short scroll distances to at least 8 seconds", () => {
    const plan = computeScrollPlan(1400, 1080, 800)
    assert.ok(plan.durationMs >= MIN_SCROLL_DURATION_MS)
    assert.ok(plan.durationMs <= MAX_SCROLL_DURATION_MS)
  })

  it("clamps tall pages to at most 90 seconds of travel", () => {
    const plan = computeScrollPlan(200_000, 1080, 800)
    assert.ok(plan.durationMs <= MAX_SCROLL_DURATION_MS)
    assert.ok(plan.scrollDistancePx < 200_000 - 1080)
  })

  it("keeps ease windows inside total duration", () => {
    const plan = computeScrollPlan(8000, 1080, 800)
    assert.ok(plan.easeMs * 2 <= plan.durationMs)
  })
})
