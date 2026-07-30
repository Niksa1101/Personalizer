import "server-only"

import Redis from "ioredis"

import { assertEnv } from "@/lib/env"
import {
  getQueue,
  getSiteSyncLastResult,
  getSiteSyncQueue,
  PIPELINE_QUEUE_NAME,
  scanLiveWorkers,
  scanWorkerBeats,
  SITE_SYNC_JOB_ID,
  type WorkerBeat,
} from "@/lib/queue"
import { resolveSetting } from "@/lib/settings"
import { getSupabaseAdmin } from "@/lib/supabase"

export type QueueHealthCounts = {
  queuedDepth: number
  delayed: number
  active: number
}

export type SiteSyncHealth = {
  depth: number
  active: number
  lastResult: "success" | "failed" | "idle" | "unknown"
}

export type ActiveJobHealth = {
  jobId: string
  campaignLeadId: string
  leadRef: string | null
  step: string | null
  startedAt: string | null
  workerId: string | null
  stale: boolean
}

export type RecentJobRun = {
  id: string
  campaignLeadId: string
  leadRef: string | null
  step: string
  state: string
  startedAt: string
  finishedAt: string | null
  errorCode: string | null
  errorDetail: string | null
  attemptCount: number | null
}

export type QueueHealth = {
  redis: "up" | "down"
  workers: WorkerBeat[]
  pipelinePaused: boolean
  dryRun: boolean
  hasStaleActive: boolean
  counts: QueueHealthCounts
  siteSync: SiteSyncHealth
  serverNow: string
  activeJobs?: ActiveJobHealth[]
  recentCompleted?: RecentJobRun[]
  recentFailed?: RecentJobRun[]
}

const healthRedisByUrl = new Map<string, Redis>()

function getHealthRedis(url: string): Redis {
  let client = healthRedisByUrl.get(url)
  if (!client) {
    client = new Redis(url, {
      connectTimeout: 1500,
      commandTimeout: 1500,
      maxRetriesPerRequest: 1,
      lazyConnect: true,
    })
    client.on("error", () => {})
    healthRedisByUrl.set(url, client)
  }
  return client
}

export async function probeRedisHealth(
  redisUrl: string = assertEnv().REDIS_URL,
): Promise<"up" | "down"> {
  const probe = async (): Promise<"up" | "down"> => {
    try {
      const client = getHealthRedis(redisUrl)
      if (client.status !== "ready") {
        await client.connect()
      }
      await client.ping()
      return "up"
    } catch {
      return "down"
    }
  }

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      probe(),
      new Promise<"down">((resolve) => {
        timeoutHandle = setTimeout(() => resolve("down"), 1500)
      }),
    ])
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle)
  }
}

export async function buildQueueHealth(opts: {
  detail?: boolean
  redisUrl?: string
}): Promise<QueueHealth> {
  const serverNow = new Date().toISOString()
  const redis = await probeRedisHealth(opts.redisUrl)

  if (redis === "down") {
    return {
      redis,
      workers: [],
      pipelinePaused: false,
      dryRun: false,
      hasStaleActive: false,
      counts: { queuedDepth: 0, delayed: 0, active: 0 },
      siteSync: { depth: 0, active: 0, lastResult: "unknown" },
      serverNow,
    }
  }

  const [
    workers,
    jobCounts,
    pipelinePaused,
    siteSyncCounts,
    siteSyncActive,
    dryRun,
    liveWorkerIds,
    openRuns,
    activeJobs,
    siteSyncLast,
  ] = await Promise.all([
    scanWorkerBeats(),
    getQueue().getJobCounts("waiting", "delayed", "active"),
    getQueue().isPaused(),
    getSiteSyncQueue().getJobCounts("waiting", "delayed"),
    getSiteSyncQueue().getJob(SITE_SYNC_JOB_ID).then(async (job) => {
      if (!job) return 0
      const state = await job.getState()
      return state === "active" ? 1 : 0
    }),
    resolveSetting("deploy.dry_run"),
    scanLiveWorkers(),
    listOpenRunsByLead(),
    getQueue().getJobs(["active"], 0, 99),
    getSiteSyncLastResult(),
  ])

  const waiting = jobCounts.waiting ?? 0
  const delayed = jobCounts.delayed ?? 0
  const active = jobCounts.active ?? 0
  const siteSyncDepth =
    (siteSyncCounts.waiting ?? 0) + (siteSyncCounts.delayed ?? 0)

  const liveWorkers = new Set(liveWorkerIds)
  const hasStaleActive = activeJobs.some((job) => {
    const campaignLeadId = job.data?.campaignLeadId ?? job.id ?? ""
    const openRun = openRuns.get(campaignLeadId)
    const workerId = openRun?.worker_id ?? null
    return workerId != null
      ? !liveWorkers.has(workerId)
      : liveWorkers.size === 0
  })

  const siteSyncLastResult: SiteSyncHealth["lastResult"] =
    siteSyncLast ?? "unknown"

  const health: QueueHealth = {
    redis,
    workers,
    pipelinePaused,
    dryRun,
    hasStaleActive,
    counts: {
      queuedDepth: waiting + delayed,
      delayed,
      active,
    },
    siteSync: {
      depth: siteSyncDepth,
      active: siteSyncActive,
      lastResult: siteSyncLastResult,
    },
    serverNow,
  }

  if (opts.detail) {
    const leadRefs = await resolveLeadRefsBatch(
      activeJobs.map((job) => job.data?.campaignLeadId ?? job.id ?? ""),
    )

    health.activeJobs = activeJobs.map((job) => {
      const campaignLeadId = job.data?.campaignLeadId ?? job.id ?? ""
      const openRun = openRuns.get(campaignLeadId)
      const workerId = openRun?.worker_id ?? null
      const stale =
        workerId != null ? !liveWorkers.has(workerId) : liveWorkers.size === 0

      return {
        jobId: job.id ?? campaignLeadId,
        campaignLeadId,
        leadRef: leadRefs.get(campaignLeadId) ?? null,
        step: openRun?.step ?? null,
        startedAt: openRun?.started_at ?? null,
        workerId,
        stale,
      }
    })

    const [recentCompleted, recentFailed] = await Promise.all([
      listRecentJobRuns("succeeded", 50),
      listRecentJobRuns("failed", 50),
    ])
    health.recentCompleted = recentCompleted
    health.recentFailed = recentFailed
  }

  return health
}

async function listOpenRunsByLead(): Promise<
  Map<string, { worker_id: string | null; step: string; started_at: string }>
> {
  const { data, error } = await getSupabaseAdmin()
    .from("job_runs")
    .select("campaign_lead_id, worker_id, step, started_at")
    .eq("state", "running")

  if (error) {
    console.error("[queue-health] failed to list open runs:", error.message)
    return new Map()
  }

  const map = new Map<
    string,
    { worker_id: string | null; step: string; started_at: string }
  >()
  for (const row of data ?? []) {
    if (!map.has(row.campaign_lead_id)) {
      map.set(row.campaign_lead_id, {
        worker_id: row.worker_id,
        step: row.step,
        started_at: row.started_at,
      })
    }
  }
  return map
}

async function resolveLeadRefsBatch(
  campaignLeadIds: string[],
): Promise<Map<string, string>> {
  const uniqueIds = [...new Set(campaignLeadIds.filter(Boolean))]
  if (uniqueIds.length === 0) return new Map()

  const { data, error } = await getSupabaseAdmin()
    .from("campaign_leads")
    .select("id, leads(ref)")
    .in("id", uniqueIds)

  if (error) {
    console.error("[queue-health] failed to resolve lead refs:", error.message)
    return new Map()
  }

  const map = new Map<string, string>()
  for (const row of data ?? []) {
    const leads = row.leads as unknown as { ref: string } | null
    if (leads?.ref) map.set(row.id, leads.ref)
  }
  return map
}

async function listRecentJobRuns(
  state: "succeeded" | "failed",
  limit: number,
): Promise<RecentJobRun[]> {
  const { data, error } = await getSupabaseAdmin()
    .from("job_runs")
    .select(
      `
      id,
      campaign_lead_id,
      step,
      state,
      started_at,
      finished_at,
      error_code,
      error_detail,
      campaign_leads (
        attempt_count,
        leads ( ref )
      )
    `,
    )
    .eq("state", state)
    .order("finished_at", { ascending: false, nullsFirst: false })
    .limit(limit)

  if (error) {
    console.error(`[queue-health] failed to list ${state} runs:`, error.message)
    return []
  }

  return (data ?? []).map((row) => {
    const cl = row.campaign_leads as unknown as {
      attempt_count: number | null
      leads: { ref: string } | null
    } | null
    return {
      id: row.id,
      campaignLeadId: row.campaign_lead_id,
      leadRef: cl?.leads?.ref ?? null,
      step: row.step,
      state: row.state,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      errorCode: row.error_code,
      errorDetail: row.error_detail,
      attemptCount: cl?.attempt_count ?? null,
    }
  })
}

export async function closeHealthRedis(): Promise<void> {
  const clients = [...healthRedisByUrl.values()]
  healthRedisByUrl.clear()
  await Promise.all(
    clients.map(async (client) => {
      // QUIT is a command: on a client that never connected — the case after a
      // down probe — it hangs or rejects, and leaves a retry handle open that
      // trips a libuv assertion when the process exits. disconnect() tears the
      // socket and its retry timer down synchronously.
      if (client.status !== "ready") {
        client.disconnect()
        return
      }
      try {
        await client.quit()
      } catch {
        client.disconnect()
      }
    }),
  )
}

export { PIPELINE_QUEUE_NAME }
