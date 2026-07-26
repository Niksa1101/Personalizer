import {
  enqueueLead,
  enqueueSiteSync,
  getLeadJobState,
  isDeployDirty,
  scanLiveWorkers,
} from "@/lib/queue"
import type { PipelineStep } from "@/lib/pipeline-types"

import {
  closeJobRun,
  hasPendingSiteSync,
  insertPipelineEvent,
  listOpenJobRuns,
  listRecoverableLeads,
} from "./db"

const RECONCILE_INTERVAL_MS = 60_000
const PERIODIC_GRACE_MS = 60_000

/**
 * Boot + periodic recovery. One listOpenJobRuns + one scanLiveWorkers feeds both
 * scans. For `active` BullMQ jobs, the lead is live only if the worker that owns
 * its open job_runs row still has a Redis liveness key.
 *
 * Re-enqueue may be dropped while a stale job still holds its BullMQ lock
 * (lockDuration 30s). Harmless: the lead stays `processing`, claimLead accepts
 * that, and BullMQ's stalled-check redelivery is functionally identical.
 */
export async function reconcile(opts?: { graceMs?: number }): Promise<void> {
  const openRunsList = await listOpenJobRuns()
  const openRunsByLead = new Map<string, (typeof openRunsList)[number]>()
  for (const run of openRunsList) {
    if (!openRunsByLead.has(run.campaign_lead_id)) {
      openRunsByLead.set(run.campaign_lead_id, run)
    }
  }

  const liveWorkers = new Set(await scanLiveWorkers())
  const closedRunIds = new Set<string>()

  const leads = await listRecoverableLeads(opts?.graceMs)

  for (const lead of leads) {
    try {
      const jobState = await getLeadJobState(lead.id)

      let live = false
      if (jobState === "waiting" || jobState === "delayed") {
        live = true
      } else if (jobState === "active") {
        const workerId = openRunsByLead.get(lead.id)?.worker_id
        live = workerId != null && liveWorkers.has(workerId)
      }

      if (live) continue

      if (lead.status === "processing") {
        const openRun = openRunsByLead.get(lead.id)
        if (openRun) {
          await closeJobRun(openRun.id, "interrupted")
          closedRunIds.add(openRun.id)
        }

        await insertPipelineEvent({
          campaignLeadId: lead.id,
          kind: "interrupted",
          message: "Worker interrupted mid-step; resuming at current step.",
          step: (lead.current_step as PipelineStep | null) ?? null,
        })
      }

      const landed = await enqueueLead(lead.id)
      if (!landed) {
        console.debug(
          `[recovery] enqueue skipped (job locked) for lead ${lead.id}`,
        )
      }
    } catch (error) {
      console.error(`[recovery] failed handling lead ${lead.id}:`, error)
    }
  }

  for (const run of openRunsList) {
    if (closedRunIds.has(run.id)) continue

    try {
      if (!run.worker_id || !liveWorkers.has(run.worker_id)) {
        await closeJobRun(run.id, "interrupted")
      }
    } catch (error) {
      console.error(`[recovery] failed closing run ${run.id}:`, error)
    }
  }
}

/**
 * Two independent signals that the site is behind the database: the Redis dirty
 * flag (fast, lost on a Redis wipe) and the durable pending_site_sync markers
 * written in-transaction with the destructive change (survive anything).
 */
export async function reconcileSiteSync(): Promise<void> {
  try {
    const [dirty, pending] = await Promise.all([
      isDeployDirty(),
      hasPendingSiteSync(),
    ])
    if (!dirty && !pending) return

    const landed = await enqueueSiteSync()
    if (!landed) {
      console.debug("[recovery] site-sync enqueue skipped (job locked)")
    }
  } catch (error) {
    console.error("[recovery] site-sync enqueue failed:", error)
  }
}

export async function runBootRecovery(): Promise<void> {
  await reconcile()
  await reconcileSiteSync()
}

export function startPeriodicReconcile(): () => void {
  let running = false

  const timer = setInterval(() => {
    if (running) {
      console.warn("[recovery] skipping tick — previous reconcile still running")
      return
    }

    running = true
    void reconcile({ graceMs: PERIODIC_GRACE_MS })
      .then(() => reconcileSiteSync())
      .catch((error) => {
        console.error("[recovery] periodic reconcile failed:", error)
      })
      .finally(() => {
        running = false
      })
  }, RECONCILE_INTERVAL_MS)

  return () => clearInterval(timer)
}
