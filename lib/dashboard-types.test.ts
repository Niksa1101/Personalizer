import { strict as assert } from "node:assert"
import { describe, it } from "node:test"

import { EMPTY_STATUS_COUNTS } from "@/lib/campaign-types"

import {
  computeBatchEtas,
  computeEtaMean,
  computeScreenState,
  deriveRecordingStallThresholdMs,
  deriveStepStallThresholdMs,
  formatEtaDuration,
  formatElapsed,
  isProcessingStalled,
} from "./dashboard-types"

describe("computeEtaMean", () => {
  it("returns null when fewer than three samples", () => {
    assert.equal(computeEtaMean([10, 20]), null)
  })

  it("returns the arithmetic mean for three or more samples", () => {
    assert.equal(computeEtaMean([60, 120, 180]), 120)
  })
})

describe("computeBatchEtas", () => {
  const batch = {
    batch_id: "00000000-0000-4000-8000-000000000001",
    ordinal: 1,
    campaign_id: "00000000-0000-4000-8000-000000000002",
    campaign_name: "Test",
    done: 0,
    failed: 0,
    paused: 0,
    remaining: 10,
    skipped: 0,
    total: 10,
    oldest_queued_at: "2026-01-01T00:00:00.000Z",
  }

  it("uses cumulative prefix divided by concurrency", () => {
    const [first, second] = computeBatchEtas(
      [
        batch,
        { ...batch, batch_id: "00000000-0000-4000-8000-000000000003", remaining: 5 },
      ],
      120,
      2,
    )
    assert.equal(first.etaSeconds, 600)
    assert.equal(second.etaSeconds, 900)
  })

  it("shows paused text when remaining is zero but paused remains", () => {
    const [result] = computeBatchEtas(
      [{ ...batch, remaining: 0, paused: 4 }],
      120,
      1,
    )
    assert.equal(result.etaLabel, "4 waiting on an intro")
  })

  it("shows estimating when mean is unavailable", () => {
    const [result] = computeBatchEtas([batch], null, 1)
    assert.equal(result.etaLabel, "estimating…")
  })
})

describe("formatEtaDuration", () => {
  it("formats sub-minute durations", () => {
    assert.equal(formatEtaDuration(30), "~under a minute")
  })

  it("formats minute durations", () => {
    assert.equal(formatEtaDuration(1500), "~25 min")
  })

  it("formats hour durations", () => {
    assert.equal(formatEtaDuration(6000), "~1h 40m")
  })
})

describe("formatElapsed", () => {
  it("formats seconds and minutes", () => {
    assert.equal(formatElapsed(45), "45s")
    assert.equal(formatElapsed(125), "2m 5s")
  })
})

describe("deriveRecordingStallThresholdMs", () => {
  it("derives the default budget from settings terms", () => {
    const threshold = deriveRecordingStallThresholdMs({
      navTimeoutMs: 120_000,
      postLoadDelayMs: 1500,
    })
    assert.equal(threshold, 410_250)
  })
})

describe("deriveStepStallThresholdMs", () => {
  it("adds grace to merge and deploy kill deadlines", () => {
    assert.equal(
      deriveStepStallThresholdMs("merge", {
        navTimeoutMs: 120_000,
        postLoadDelayMs: 1500,
        mergeTimeoutMs: 1_800_000,
        deployTimeoutMs: 300_000,
      }),
      1_830_000,
    )
    assert.equal(
      deriveStepStallThresholdMs("deploy", {
        navTimeoutMs: 120_000,
        postLoadDelayMs: 1500,
        mergeTimeoutMs: 1_800_000,
        deployTimeoutMs: 300_000,
      }),
      330_000,
    )
  })

  it("uses a flat page threshold", () => {
    assert.equal(
      deriveStepStallThresholdMs("page", {
        navTimeoutMs: 120_000,
        postLoadDelayMs: 1500,
        mergeTimeoutMs: 1_800_000,
        deployTimeoutMs: 300_000,
      }),
      120_000,
    )
  })
})

describe("isProcessingStalled", () => {
  it("returns false without a step start timestamp", () => {
    assert.equal(isProcessingStalled(null, 1000), false)
  })

  it("returns true once elapsed exceeds the threshold", () => {
    const startedAt = new Date("2026-01-01T00:00:00.000Z").toISOString()
    assert.equal(
      isProcessingStalled(startedAt, 60_000, Date.parse("2026-01-01T00:02:00.000Z")),
      true,
    )
  })
})

describe("computeScreenState", () => {
  it("returns empty when there are no campaigns", () => {
    assert.equal(computeScreenState(false, EMPTY_STATUS_COUNTS()), "empty")
  })

  it("returns running when queued or processing leads exist", () => {
    const tiles = EMPTY_STATUS_COUNTS()
    tiles.queued = 2
    assert.equal(computeScreenState(true, tiles), "running")
  })

  it("returns idle when campaigns exist but no leads", () => {
    assert.equal(computeScreenState(true, EMPTY_STATUS_COUNTS()), "idle")
  })

  it("returns all-done when every lead is terminal", () => {
    const tiles = EMPTY_STATUS_COUNTS()
    tiles.deployed = 3
    tiles.failed = 1
    assert.equal(computeScreenState(true, tiles), "all-done")
  })
})
