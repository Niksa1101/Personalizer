import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  collectScreenshotPathRefs,
  groupVideosByWebPath,
  reduceNewestPerLead,
  type ScreenshotRecordingRow,
} from "@/worker/cleanup/sweeps"

describe("reduceNewestPerLead", () => {
  it("picks newest by created_at then id", () => {
    const rows: ScreenshotRecordingRow[] = [
      {
        id: "a",
        lead_id: "lead-1",
        created_at: "2026-01-01T00:00:00.000Z",
        screenshot_before_path: "b/a.png",
        screenshot_after_path: null,
      },
      {
        id: "b",
        lead_id: "lead-1",
        created_at: "2026-02-01T00:00:00.000Z",
        screenshot_before_path: "b/b.png",
        screenshot_after_path: null,
      },
    ]

    const result = reduceNewestPerLead(rows, "2026-03-01T00:00:00.000Z")
    assert.equal(result.get("lead-1")?.id, "b")
  })

  it("drops lead when newest row is inside cutoff", () => {
    const rows: ScreenshotRecordingRow[] = [
      {
        id: "a",
        lead_id: "lead-1",
        created_at: "2026-03-01T00:00:00.000Z",
        screenshot_before_path: "b/a.png",
        screenshot_after_path: null,
      },
    ]

    const result = reduceNewestPerLead(rows, "2026-02-01T00:00:00.000Z")
    assert.equal(result.has("lead-1"), false)
  })
})

describe("groupVideosByWebPath", () => {
  it("groups sharing rows", () => {
    const grouped = groupVideosByWebPath([
      { web_path: "batch/acme/web.mp4", id: "1" },
      { web_path: "batch/acme/web.mp4", id: "2" },
      { web_path: "other/web.mp4", id: "3" },
    ])
    assert.equal(grouped.get("batch/acme/web.mp4")?.length, 2)
    assert.equal(grouped.get("other/web.mp4")?.length, 1)
  })
})

describe("collectScreenshotPathRefs", () => {
  it("collects every distinct row+column path", () => {
    const refs = collectScreenshotPathRefs([
      {
        id: "1",
        lead_id: "l",
        created_at: "2026-01-01",
        screenshot_before_path: "batch-a/x/before.png",
        screenshot_after_path: null,
      },
      {
        id: "2",
        lead_id: "l",
        created_at: "2026-02-01",
        screenshot_before_path: "batch-b/x/before.png",
        screenshot_after_path: "batch-b/x/after.png",
      },
    ])

    assert.equal(refs.length, 3)
    assert.deepEqual(
      refs.map((ref) => ref.relPath).sort(),
      [
        "batch-a/x/before.png",
        "batch-b/x/after.png",
        "batch-b/x/before.png",
      ].sort(),
    )
  })

  it("keeps separate refs when two stale rows share a column name", () => {
    const refs = collectScreenshotPathRefs([
      {
        id: "old",
        lead_id: "l",
        created_at: "2026-01-01",
        screenshot_before_path: "batch/old-before.png",
        screenshot_after_path: null,
      },
      {
        id: "older",
        lead_id: "l",
        created_at: "2025-12-01",
        screenshot_before_path: "batch/older-before.png",
        screenshot_after_path: null,
      },
    ])

    assert.equal(refs.length, 2)
    assert.equal(
      refs.filter((ref) => ref.column === "screenshot_before_path").length,
      2,
    )
  })
})
