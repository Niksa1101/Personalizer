import {
  emptyCleanupCounts,
  getCleanupLastRun,
  setCleanupLastRun,
  type CleanupRunSummary,
} from "@/lib/cleanup-state"
import { acquireRedisLock } from "@/lib/redis-lock"
import {
  enqueueCleanup,
  getCleanupQueue,
  type CleanupTrigger,
} from "@/lib/queue"
import { resolveMany } from "@/lib/settings"
import { getSupabaseAdmin } from "@/lib/supabase"

import { writeStepLog } from "../db"
import { runCleanupSweeps } from "./sweeps"

export const CLEANUP_LOCK_KEY = "pz:cleanup:lock"
const DAY_MS = 24 * 60 * 60 * 1000

export type { CleanupTrigger }

async function writeSummary(input: {
  prior: CleanupRunSummary | null
  startedAt: string
  ok: boolean
  dryRun: boolean
  skipped: CleanupRunSummary["skipped"]
  trigger?: CleanupTrigger
  truncated?: boolean
  cutoffs?: { recordingDays: number; screenshotDays: number }
  counts?: ReturnType<typeof emptyCleanupCounts>
  bytesFreed?: number
  errorSamples?: string[]
  error?: unknown
}): Promise<void> {
  const finishedAt = new Date().toISOString()
  const priorSuccess = input.prior?.lastSuccessAt ?? null
  const advanceSuccess =
    input.ok && !input.dryRun && input.skipped === null

  const summary: CleanupRunSummary = {
    startedAt: input.startedAt,
    finishedAt,
    ok: input.ok,
    dryRun: input.dryRun,
    skipped: input.skipped,
    truncated: input.truncated ?? false,
    cutoffs: input.cutoffs ?? {
      recordingDays: 0,
      screenshotDays: 0,
    },
    counts: input.counts ?? emptyCleanupCounts(),
    bytesFreed: input.bytesFreed ?? 0,
    errorSamples: input.errorSamples ?? [],
    lastSuccessAt: advanceSuccess ? finishedAt : priorSuccess,
  }

  if (!input.ok && input.error) {
    const message =
      input.error instanceof Error ? input.error.message : String(input.error)
    summary.errorSamples = [...summary.errorSamples, message].slice(0, 10)
  }

  await setCleanupLastRun(summary)

  const errorCount = summary.counts.errors
  await writeStepLog({
    scope: "worker",
    level: errorCount > 0 ? "warn" : "info",
    message: input.skipped
      ? `Cleanup skipped (${input.skipped})`
      : input.ok
        ? `Cleanup finished${input.dryRun ? " (dry run)" : ""}`
        : "Cleanup failed",
    meta: {
      trigger: input.trigger ?? null,
      counts: summary.counts,
      cutoffs: summary.cutoffs,
      truncated: summary.truncated,
      bytesFreed: summary.bytesFreed,
      dryRun: summary.dryRun,
      skipped: summary.skipped,
    },
  })
}

export async function runCleanupJob(opts: {
  trigger: CleanupTrigger
}): Promise<void> {
  const { trigger } = opts
  const startedAt = new Date().toISOString()

  const lock = await acquireRedisLock({
    key: CLEANUP_LOCK_KEY,
    ttlMs: 120_000,
    renewMs: 30_000,
    waitMs: 0,
  })

  if (!lock) {
    console.info("[cleanup] already running, skipping")
    const prior = await getCleanupLastRun()
    const settings = await resolveMany([
      "recorder.retention_days",
      "cleanup.screenshot_retention_days",
    ])
    await writeSummary({
      prior,
      startedAt,
      ok: true,
      dryRun: false,
      skipped: "locked",
      trigger,
      cutoffs: {
        recordingDays: settings["recorder.retention_days"],
        screenshotDays: settings["cleanup.screenshot_retention_days"],
      },
    })
    return
  }

  const stopRenewal = lock.startRenewal()
  const prior = await getCleanupLastRun()

  try {
    const settings = await resolveMany([
      "cleanup.enabled",
      "cleanup.dry_run",
      "recorder.retention_days",
      "cleanup.screenshot_retention_days",
    ])

    if (!settings["cleanup.enabled"]) {
      await writeSummary({
        prior,
        startedAt,
        ok: true,
        dryRun: false,
        skipped: "disabled",
        trigger,
        cutoffs: {
          recordingDays: settings["recorder.retention_days"],
          screenshotDays: settings["cleanup.screenshot_retention_days"],
        },
      })
      return
    }

    const result = await runCleanupSweeps({
      supabase: getSupabaseAdmin(),
      dryRun: settings["cleanup.dry_run"],
      recDays: settings["recorder.retention_days"],
      shotDays: settings["cleanup.screenshot_retention_days"],
    })

    await writeSummary({
      prior,
      startedAt,
      ok: true,
      dryRun: settings["cleanup.dry_run"],
      skipped: null,
      trigger,
      truncated: result.truncated,
      cutoffs: {
        recordingDays: settings["recorder.retention_days"],
        screenshotDays: settings["cleanup.screenshot_retention_days"],
      },
      counts: result.counts,
      bytesFreed: result.bytesFreed,
      errorSamples: result.errorSamples,
    })
  } catch (error) {
    console.error("[cleanup] job failed:", error)
    await writeSummary({
      prior,
      startedAt,
      ok: false,
      dryRun: false,
      skipped: null,
      trigger,
      error,
    })
  } finally {
    stopRenewal()
    await lock.release()
  }
}

export async function armCleanupScheduler(): Promise<void> {
  await getCleanupQueue().upsertJobScheduler(
    "daily-cleanup",
    { pattern: "0 3 * * *" },
    {
      name: "cleanup",
      data: { trigger: "scheduled" },
      opts: {
        attempts: 1,
        removeOnComplete: 10,
        removeOnFail: false,
      },
    },
  )
}

/** Both entry points gate on the blob, not just this one — a worker returning
 *  at 03:05 must not run the scheduler fire and the catch-up (D2). */
export function isCleanupDue(
  prior: CleanupRunSummary | null,
  now: Date,
): boolean {
  if (!prior?.lastSuccessAt) return true
  return now.getTime() - Date.parse(prior.lastSuccessAt) >= DAY_MS
}

export { enqueueCleanup, getCleanupLastRun }
