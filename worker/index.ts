/**
 * Worker process entry point.
 *
 * Runs as a genuinely separate process from the Next.js server — started with
 * `npm run worker`, alongside `npm run dev`. See docs/Tech.md §2.
 */

import { hostname } from "node:os"

import { Worker } from "bullmq"

import { assertEnvOrExit } from "../lib/env-node"
import { sweepStaleRecorderTemps } from "../lib/local-file"
import {
  closeQueueConnections,
  deleteLiveness,
  enqueueCleanup,
  enqueueLead,
  enqueueSiteSync,
  getRedis,
  type CleanupJobData,
  isDeployDirty,
  CLEANUP_QUEUE_NAME,
  PIPELINE_QUEUE_NAME,
  registerLiveness,
  setSiteSyncLastResult,
  SITE_SYNC_QUEUE_NAME,
  startWorkerHeartbeats,
  type WorkerBeatPayload,
} from "../lib/queue"
import type { StepOutcome } from "../lib/pipeline-types"
import { resolveMany } from "../lib/settings"
import { SETTING_DEFAULTS } from "../lib/settings-schema"
import { storageAbs } from "../lib/storage"

import { runSiteSync } from "./deploy/sync"

/** Backs a persistently failing sync off instead of hot-looping the queue. */
const SITE_SYNC_RETRY_DELAY_MS = 60_000
import { processLeadJob } from "./pipeline"
import { runBootRecovery, startPeriodicReconcile } from "./recovery"
import { closeSharedBrowser } from "./recorder/browser"
import {
  armCleanupScheduler,
  isCleanupDue,
  runCleanupJob,
} from "./cleanup/job"
import { getCleanupLastRun } from "@/lib/cleanup-state"

const SHUTDOWN_DRAIN_MS = 30_000

async function main(): Promise<void> {
  assertEnvOrExit()

  const workerId = `${hostname()}:${process.pid}`
  console.log(`[worker] starting (${workerId})`)

  await registerLiveness(workerId)

  // Alive key TTL is 15 s; boot recovery + temp sweep can exceed it. Starting
  // heartbeats first keeps scanLiveWorkers() seeing this worker so reconcile()
  // won't orphan in-flight leads. The beat self-corrects within one 2 s tick.
  const workerStartedAt = new Date().toISOString()
  let currentConcurrency = SETTING_DEFAULTS["queue.concurrency"]
  const beatPayload = (): WorkerBeatPayload => ({
    concurrency: currentConcurrency,
    startedAt: workerStartedAt,
    pid: process.pid,
  })
  const stopHeartbeats = startWorkerHeartbeats(workerId, beatPayload)

  await runBootRecovery()
  await sweepStaleRecorderTemps(storageAbs("tmp"))

  await armCleanupScheduler().catch((error) => {
    console.error("[worker] cleanup scheduler arm failed:", error)
  })

  if (await isCleanupDue(await getCleanupLastRun(), new Date())) {
    await enqueueCleanup(`cleanup-catchup-${Date.now()}`, "catchup").catch(
      (error) => {
        console.error("[worker] cleanup catch-up enqueue failed:", error)
      },
    )
  }

  const settings = await resolveMany(["queue.concurrency"])
  currentConcurrency = settings["queue.concurrency"]

  const shutdownController = new AbortController()
  let shuttingDown = false

  const bullWorker = new Worker<{ campaignLeadId: string }>(
    PIPELINE_QUEUE_NAME,
    async (job) =>
      processLeadJob(job, {
        workerId,
        signal: shutdownController.signal,
      }),
    {
      connection: getRedis(),
      concurrency: currentConcurrency,
    },
  )

  bullWorker.on("completed", (job, result: StepOutcome) => {
    void (async () => {
      try {
        if (result?.kind === "retry") {
          await enqueueLead(job.data.campaignLeadId, { delayMs: result.delayMs })
        }
      } catch (error) {
        console.error(
          `[worker] completed-listener enqueue failed for ${job.data.campaignLeadId}:`,
          error,
        )
      }
    })()
  })

  bullWorker.on("failed", (job, error) => {
    console.error(
      `[worker] job ${job?.id ?? "?"} failed unexpectedly:`,
      error,
    )
  })

  const siteSyncWorker = new Worker<Record<string, never>>(
    SITE_SYNC_QUEUE_NAME,
    async () => runSiteSync({ signal: shutdownController.signal }),
    {
      connection: getRedis(),
      concurrency: 1,
    },
  )

  siteSyncWorker.on("completed", () => {
    void (async () => {
      try {
        await setSiteSyncLastResult("success")
        if (await isDeployDirty()) {
          const landed = await enqueueSiteSync()
          if (!landed) {
            console.debug("[worker] site-sync re-enqueue skipped (job locked)")
          }
        }
      } catch (error) {
        console.error("[worker] site-sync completed-listener failed:", error)
      }
    })()
  })

  siteSyncWorker.on("failed", (job, error) => {
    console.error(
      `[worker] site-sync job ${job?.id ?? "?"} failed:`,
      error,
    )

    // Only re-enqueue once BullMQ has spent its own attempts — otherwise this
    // races the retry. Without this the dirty flag stays set with no consumer
    // until the next worker boot, and deleted pages stay published.
    const attemptsExhausted =
      job == null || job.attemptsMade >= (job.opts.attempts ?? 1)
    if (!attemptsExhausted) return

    void (async () => {
      try {
        await setSiteSyncLastResult("failed")
        if (await isDeployDirty()) {
          const landed = await enqueueSiteSync({
            delayMs: SITE_SYNC_RETRY_DELAY_MS,
          })
          if (!landed) {
            console.debug("[worker] site-sync retry enqueue skipped (job locked)")
          }
        }
      } catch (enqueueError) {
        console.error(
          "[worker] site-sync failed-listener re-enqueue failed:",
          enqueueError,
        )
      }
    })()
  })

  const cleanupWorker = new Worker<CleanupJobData>(
    CLEANUP_QUEUE_NAME,
    async (job) =>
      runCleanupJob({ trigger: job.data.trigger ?? "scheduled" }),
    {
      connection: getRedis(),
      concurrency: 1,
    },
  )

  cleanupWorker.on("failed", (job, error) => {
    console.error(
      `[worker] cleanup job ${job?.id ?? "?"} failed:`,
      error,
    )
  })

  const stopPeriodicReconcile = startPeriodicReconcile({
    onAfterTick: async () => {
      const nextSettings = await resolveMany(["queue.concurrency"])
      const next = nextSettings["queue.concurrency"]
      if (next !== currentConcurrency) {
        bullWorker.concurrency = next
        currentConcurrency = next
        console.log(`[worker] concurrency updated to ${next}`)
      }
    },
  })

  console.log(`[worker] consuming (concurrency=${currentConcurrency})`)

  const shutdown = async (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`[worker] ${signal} received — draining…`)

    shutdownController.abort()

    const drainPromise = Promise.all([
      bullWorker.close(),
      siteSyncWorker.close(),
      cleanupWorker.close(),
    ])
    const timeout = new Promise<void>((_, reject) => {
      setTimeout(
        () => reject(new Error("shutdown drain timed out")),
        SHUTDOWN_DRAIN_MS,
      )
    })

    try {
      await Promise.race([drainPromise, timeout])
    } catch (error) {
      console.error("[worker] drain error:", error)
    }

    stopPeriodicReconcile()
    stopHeartbeats()
    await closeSharedBrowser().catch((error) => {
      console.error("[worker] browser close error:", error)
    })
    await deleteLiveness(workerId)
    await closeQueueConnections()

    console.log("[worker] stopped")
    process.exit(0)
  }

  process.on("SIGINT", () => {
    shutdown("SIGINT").catch((error) => {
      console.error("[worker] SIGINT shutdown failed:", error)
      process.exit(1)
    })
  })
  process.on("SIGTERM", () => {
    shutdown("SIGTERM").catch((error) => {
      console.error("[worker] SIGTERM shutdown failed:", error)
      process.exit(1)
    })
  })

  process.on("unhandledRejection", (reason) => {
    console.error("[worker] unhandledRejection:", reason)
  })

  process.on("uncaughtException", (error) => {
    console.error("[worker] uncaughtException:", error)
    process.exit(1)
  })
}

main().catch((error) => {
  console.error("[worker] fatal:", error)
  process.exit(1)
})
