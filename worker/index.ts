/**
 * Worker process entry point.
 *
 * Runs as a genuinely separate process from the Next.js server — started with
 * `npm run worker`, alongside `npm run dev`. See docs/Tech.md §2.
 */

import { hostname } from "node:os"

import { Worker } from "bullmq"

import { assertEnvOrExit } from "../lib/env-node"
import {
  closeQueueConnections,
  deleteLiveness,
  PIPELINE_QUEUE_NAME,
  enqueueLead,
  getRedis,
  registerLiveness,
  startLivenessRefresh,
} from "../lib/queue"
import type { StepOutcome } from "../lib/pipeline-types"
import { resolveMany } from "../lib/settings"

import { processLeadJob } from "./pipeline"
import { runBootRecovery, startPeriodicReconcile } from "./recovery"

const SHUTDOWN_DRAIN_MS = 30_000

async function main(): Promise<void> {
  assertEnvOrExit()

  const workerId = `${hostname()}:${process.pid}`
  console.log(`[worker] starting (${workerId})`)

  await registerLiveness(workerId)
  const stopLivenessRefresh = startLivenessRefresh(workerId)

  await runBootRecovery()

  const settings = await resolveMany(["queue.concurrency"])
  const concurrency = settings["queue.concurrency"]

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
      concurrency,
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

  const stopPeriodicReconcile = startPeriodicReconcile()

  console.log(`[worker] consuming (concurrency=${concurrency})`)

  const shutdown = async (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`[worker] ${signal} received — draining…`)

    shutdownController.abort()

    const drainPromise = bullWorker.close()
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
    stopLivenessRefresh()
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
