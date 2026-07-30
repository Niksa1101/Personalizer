import "server-only"

import { assertRedisConnected, getRedis } from "@/lib/queue"

export const CLEANUP_LAST_KEY = "pz:cleanup:last"

export type CleanupCounts = {
  rowsVisited: number
  recordingsPurged: number
  recordingsAlreadyGone: number
  recordingsSkippedBusy: number
  recordingsSkippedRevived: number
  webCopiesDeleted: number
  webCopiesSkippedShared: number
  webCopiesSkippedBusy: number
  screenshotLeadsVisited: number
  screenshotLeadsPruned: number
  screenshotLeadsSpared: number
  screenshotLeadsSkippedBusy: number
  screenshotFilesDeleted: number
  /** Temp-cleanup targets processed (lead dirs + global tmp sweeps), not file count. */
  tempsRemoved: number
  errors: number
}

export type CleanupRunSummary = {
  startedAt: string
  finishedAt: string
  ok: boolean
  dryRun: boolean
  skipped: "disabled" | "locked" | null
  truncated: boolean
  cutoffs: { recordingDays: number; screenshotDays: number }
  counts: CleanupCounts
  bytesFreed: number
  errorSamples: string[]
  lastSuccessAt: string | null
}

export function emptyCleanupCounts(): CleanupCounts {
  return {
    rowsVisited: 0,
    recordingsPurged: 0,
    recordingsAlreadyGone: 0,
    recordingsSkippedBusy: 0,
    recordingsSkippedRevived: 0,
    webCopiesDeleted: 0,
    webCopiesSkippedShared: 0,
    webCopiesSkippedBusy: 0,
    screenshotLeadsVisited: 0,
    screenshotLeadsPruned: 0,
    screenshotLeadsSpared: 0,
    screenshotLeadsSkippedBusy: 0,
    screenshotFilesDeleted: 0,
    tempsRemoved: 0,
    errors: 0,
  }
}

function isCleanupRunSummary(value: unknown): value is CleanupRunSummary {
  if (value == null || typeof value !== "object") return false
  const v = value as Partial<CleanupRunSummary>
  return (
    typeof v.startedAt === "string" &&
    typeof v.finishedAt === "string" &&
    typeof v.ok === "boolean" &&
    typeof v.dryRun === "boolean" &&
    (v.skipped === null ||
      v.skipped === "disabled" ||
      v.skipped === "locked") &&
    typeof v.truncated === "boolean" &&
    v.counts != null &&
    typeof v.counts === "object"
  )
}

export async function getCleanupLastRun(): Promise<CleanupRunSummary | null> {
  try {
    await assertRedisConnected()
    const raw = await getRedis().get(CLEANUP_LAST_KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (!isCleanupRunSummary(parsed)) return null
    return parsed
  } catch {
    return null
  }
}

export async function setCleanupLastRun(
  summary: CleanupRunSummary,
): Promise<void> {
  await assertRedisConnected()
  await getRedis().set(CLEANUP_LAST_KEY, JSON.stringify(summary))
}
