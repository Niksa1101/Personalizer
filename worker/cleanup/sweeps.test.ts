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

describe("pruneHeartbeats", () => {
  it("dry-run counts stale rows without deleting", async () => {
    const { pruneHeartbeats, HEARTBEAT_RETENTION_DAYS } = await import(
      "@/worker/cleanup/sweeps"
    )
    const now = new Date("2026-06-01T00:00:00.000Z")
    const calls: string[] = []
    const supabase = {
      from(table: string) {
        assert.equal(table, "heartbeat")
        return {
          select(_cols: string, opts?: { count?: string; head?: boolean }) {
            if (opts?.head) {
              return {
                lt(_col: string, cutoff: string) {
                  calls.push(`count:${cutoff}`)
                  return Promise.resolve({ count: 3, error: null })
                },
              }
            }
            return {
              lt() {
                return { select: () => Promise.resolve({ data: [], error: null }) }
              },
            }
          },
          delete() {
            throw new Error("delete should not run in dry-run")
          },
        }
      },
    }

    const result = await pruneHeartbeats({
      supabase: supabase as never,
      dryRun: true,
      now,
    })
    assert.equal(result.deleted, 3)
    assert.equal(calls.length, 1)
    const expectedCutoff = new Date(
      now.getTime() - HEARTBEAT_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString()
    assert.equal(calls[0], `count:${expectedCutoff}`)
  })

  it("wet run deletes stale rows", async () => {
    const { pruneHeartbeats } = await import("@/worker/cleanup/sweeps")
    const now = new Date("2026-06-01T00:00:00.000Z")
    let deleted = false
    const supabase = {
      from(table: string) {
        assert.equal(table, "heartbeat")
        return {
          delete() {
            deleted = true
            return {
              lt(_col: string, cutoff: string) {
                assert.match(cutoff, /^\d{4}-/)
                return {
                  select: () =>
                    Promise.resolve({
                      data: [{ id: 1 }, { id: 2 }],
                      error: null,
                    }),
                }
              },
            }
          },
        }
      },
    }

    const result = await pruneHeartbeats({
      supabase: supabase as never,
      dryRun: false,
      now,
    })
    assert.equal(deleted, true)
    assert.equal(result.deleted, 2)
  })
})
