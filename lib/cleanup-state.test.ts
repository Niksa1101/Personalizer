import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  emptyCleanupCounts,
  type CleanupRunSummary,
} from "@/lib/cleanup-state"

describe("cleanup-state types", () => {
  it("emptyCleanupCounts has zero errors", () => {
    const counts = emptyCleanupCounts()
    assert.equal(counts.errors, 0)
    assert.equal(counts.recordingsPurged, 0)
  })

  it("lastSuccessAt carry-forward shape", () => {
    const prior: CleanupRunSummary = {
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:01:00.000Z",
      ok: true,
      dryRun: false,
      skipped: null,
      truncated: false,
      cutoffs: { recordingDays: 30, screenshotDays: 30 },
      counts: emptyCleanupCounts(),
      bytesFreed: 0,
      errorSamples: [],
      lastSuccessAt: "2026-01-01T00:01:00.000Z",
    }

    const failed: CleanupRunSummary = {
      ...prior,
      ok: false,
      finishedAt: "2026-01-02T00:00:00.000Z",
      lastSuccessAt: prior.lastSuccessAt,
    }

    assert.equal(failed.lastSuccessAt, prior.lastSuccessAt)
  })
})
