import "server-only"

import { Queue, type JobsOptions } from "bullmq"
import Redis from "ioredis"

import { assertEnv } from "@/lib/env"

export const PIPELINE_QUEUE_NAME = "pipeline"
export const SITE_SYNC_QUEUE_NAME = "site-sync"
export const CLEANUP_QUEUE_NAME = "cleanup"
export const SITE_SYNC_JOB_ID = "site-sync"

export type CleanupTrigger = "scheduled" | "manual" | "catchup"
export type CleanupJobData = { trigger: CleanupTrigger }

const LIVENESS_PREFIX = "pz:worker:alive:"
const LIVENESS_TTL_SECONDS = 15
const BOOT_MUTEX_KEY = "pz:worker:boot-mutex"
const BOOT_MUTEX_TTL_SECONDS = 10
/** Beat key drives the health endpoint's worker-down indicator (4 s TTL).
 *  Alive key drives reconcile() recovery (15 s TTL) — do not shorten it. */
const BEAT_PREFIX = "pz:worker:beat:"
const BEAT_TTL_SECONDS = 4
const BEAT_REFRESH_MS = 2_000
const SITE_SYNC_LAST_KEY = "pz:sitesync:last"

export type WorkerBeatPayload = {
  concurrency: number
  startedAt: string
  pid: number
}

export type WorkerBeat = WorkerBeatPayload & {
  workerId: string
}

let redis: Redis | null = null
let queue: Queue | null = null
let siteSyncQueue: Queue | null = null
let cleanupQueue: Queue | null = null

export function getRedis(): Redis {
  if (redis) return redis

  const env = assertEnv()
  redis = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    lazyConnect: true,
  })

  redis.on("error", (error) => {
    console.error("[redis]", error.message)
  })

  return redis
}

async function ensureRedisConnected(): Promise<void> {
  const client = getRedis()
  if (client.status === "ready") return
  await client.connect()
}

/** Throws if Redis is unreachable — for verification scripts. */
export async function assertRedisConnected(): Promise<void> {
  await ensureRedisConnected()
}

export function getQueue(): Queue {
  if (queue) return queue

  queue = new Queue(PIPELINE_QUEUE_NAME, {
    connection: getRedis(),
  })

  return queue
}

export function getSiteSyncQueue(): Queue {
  if (siteSyncQueue) return siteSyncQueue

  siteSyncQueue = new Queue(SITE_SYNC_QUEUE_NAME, {
    connection: getRedis(),
  })

  return siteSyncQueue
}

export function getCleanupQueue(): Queue {
  if (cleanupQueue) return cleanupQueue

  cleanupQueue = new Queue(CLEANUP_QUEUE_NAME, {
    connection: getRedis(),
  })

  return cleanupQueue
}

async function ensureQueueReady(): Promise<Queue> {
  await ensureRedisConnected()
  return getQueue()
}

async function ensureSiteSyncQueueReady(): Promise<Queue> {
  await ensureRedisConnected()
  return getSiteSyncQueue()
}

async function ensureCleanupQueueReady(): Promise<Queue> {
  await ensureRedisConnected()
  return getCleanupQueue()
}

function deployDirtyKey(siteId?: string): string {
  const resolvedSiteId = siteId ?? assertEnv().NETLIFY_SITE_ID
  return `pz:deploy:dirty:${resolvedSiteId}`
}

export function manifestCacheKey(siteId?: string): string {
  const resolvedSiteId = siteId ?? assertEnv().NETLIFY_SITE_ID
  return `pz:deploy:manifest:${resolvedSiteId}`
}

export type ManifestCacheEntry = {
  sha: string
  deploy_id: string
  at: string
  paths: string[]
}

export async function setDeployDirty(siteId?: string): Promise<void> {
  await ensureRedisConnected()
  await getRedis().set(deployDirtyKey(siteId), "1")
}

export async function clearDeployDirty(siteId?: string): Promise<void> {
  await ensureRedisConnected()
  await getRedis().del(deployDirtyKey(siteId))
}

/** Redis read errors count as dirty (D54). */
export async function isDeployDirty(siteId?: string): Promise<boolean> {
  try {
    await ensureRedisConnected()
    const value = await getRedis().get(deployDirtyKey(siteId))
    return value != null
  } catch {
    return true
  }
}

export async function getManifestCache(
  siteId?: string,
): Promise<ManifestCacheEntry | null> {
  try {
    await ensureRedisConnected()
    const raw = await getRedis().get(manifestCacheKey(siteId))
    if (!raw) return null
    return JSON.parse(raw) as ManifestCacheEntry
  } catch {
    return null
  }
}

export async function setManifestCache(
  entry: ManifestCacheEntry,
  siteId?: string,
): Promise<void> {
  await ensureRedisConnected()
  await getRedis().set(manifestCacheKey(siteId), JSON.stringify(entry))
}

async function addWithReplace(
  q: Queue,
  jobId: string,
  name: string,
  data: unknown,
  opts: JobsOptions,
): Promise<boolean> {
  let removable = true
  try {
    await q.remove(jobId)
  } catch {
    // Locked — the following add with the same jobId will no-op.
    removable = false
  }

  await q.add(name, data, {
    ...opts,
    jobId,
  })

  return removable
}

export type LeadJobState =
  | "absent"
  | "waiting"
  | "active"
  | "delayed"
  | "completed"
  | "failed"
  | "unknown"

export async function getLeadJobState(
  campaignLeadId: string,
): Promise<LeadJobState> {
  await ensureRedisConnected()
  const job = await (await ensureQueueReady()).getJob(campaignLeadId)
  if (!job) return "absent"

  const state = await job.getState()
  switch (state) {
    case "waiting":
    case "active":
    case "delayed":
    case "completed":
    case "failed":
      return state
    default:
      return "unknown"
  }
}

/**
 * The two queue.add callers share addWithReplace(). See docs/Tech.md §7.1.
 * Returns false when the prior remove failed because the job is locked —
 * BullMQ then silently drops the add with the same jobId.
 */
export async function enqueueLead(
  campaignLeadId: string,
  opts?: { delayMs?: number },
): Promise<boolean> {
  return addWithReplace(
    await ensureQueueReady(),
    campaignLeadId,
    "process-lead",
    { campaignLeadId },
    {
      delay: opts?.delayMs,
      removeOnComplete: 100,
      removeOnFail: false,
    },
  )
}

const SITE_SYNC_ATTEMPTS = 5
const SITE_SYNC_BACKOFF_MS = 10_000

/**
 * A dropped site-sync leaves deleted pages published, so the job retries on its
 * own rather than waiting for the next worker boot. The `failed` listener still
 * re-enqueues once attempts are exhausted and the dirty flag is set.
 */
export async function enqueueSiteSync(opts?: {
  delayMs?: number
}): Promise<boolean> {
  await setDeployDirty()
  return addWithReplace(
    await ensureSiteSyncQueueReady(),
    SITE_SYNC_JOB_ID,
    "site-sync",
    {},
    {
      delay: opts?.delayMs,
      attempts: SITE_SYNC_ATTEMPTS,
      backoff: { type: "exponential", delay: SITE_SYNC_BACKOFF_MS },
      removeOnComplete: true,
      removeOnFail: false,
    },
  )
}

export async function enqueueCleanup(
  jobId: string,
  trigger: CleanupTrigger,
): Promise<void> {
  await ensureRedisConnected()
  await (await ensureCleanupQueueReady()).add(
    "cleanup",
    { trigger } satisfies CleanupJobData,
    {
      jobId,
      attempts: 1,
      removeOnComplete: 10,
      removeOnFail: false,
    },
  )
}

function livenessKey(workerId: string): string {
  return `${LIVENESS_PREFIX}${workerId}`
}

function beatKey(workerId: string): string {
  return `${BEAT_PREFIX}${workerId}`
}

export async function registerLiveness(workerId: string): Promise<void> {
  await ensureRedisConnected()
  await getRedis().set(livenessKey(workerId), "1", "EX", LIVENESS_TTL_SECONDS)
}

/** Serializes check-then-register at boot. Held for milliseconds; the TTL is only a
 *  crash guard. The real single-worker signal is the liveness key. */
export async function acquireBootMutex(): Promise<boolean> {
  await ensureRedisConnected()
  const result = await getRedis().set(
    BOOT_MUTEX_KEY,
    "1",
    "EX",
    BOOT_MUTEX_TTL_SECONDS,
    "NX",
  )
  return result === "OK"
}

export async function releaseBootMutex(): Promise<void> {
  await ensureRedisConnected()
  await getRedis().del(BOOT_MUTEX_KEY)
}

export { LIVENESS_TTL_SECONDS }

async function refreshHeartbeats(
  workerId: string,
  payload: WorkerBeatPayload,
): Promise<void> {
  const client = getRedis()
  const pipeline = client.pipeline()
  pipeline.set(livenessKey(workerId), "1", "EX", LIVENESS_TTL_SECONDS)
  pipeline.set(
    beatKey(workerId),
    JSON.stringify(payload),
    "EX",
    BEAT_TTL_SECONDS,
  )
  await pipeline.exec()
}

export async function deleteLiveness(workerId: string): Promise<void> {
  const client = getRedis()
  await client.del(livenessKey(workerId), beatKey(workerId))
}

export type SiteSyncLastResult = "success" | "failed"

export async function getSiteSyncLastResult(): Promise<
  SiteSyncLastResult | null
> {
  try {
    await ensureRedisConnected()
    const raw = await getRedis().get(SITE_SYNC_LAST_KEY)
    if (raw === "success" || raw === "failed") return raw
    return null
  } catch {
    return null
  }
}

export async function setSiteSyncLastResult(
  result: SiteSyncLastResult,
): Promise<void> {
  await ensureRedisConnected()
  await getRedis().set(SITE_SYNC_LAST_KEY, result)
}

export function startWorkerHeartbeats(
  workerId: string,
  getPayload: () => WorkerBeatPayload,
): () => void {
  const tick = () => {
    void refreshHeartbeats(workerId, getPayload()).catch((error) => {
      console.error("[worker] heartbeat refresh failed:", error)
    })
  }

  tick()
  const timer = setInterval(tick, BEAT_REFRESH_MS)
  return () => clearInterval(timer)
}

export async function scanLiveWorkers(): Promise<string[]> {
  try {
    await ensureRedisConnected()
  } catch {
    return []
  }

  const client = getRedis()
  const pattern = `${LIVENESS_PREFIX}*`
  const workerIds: string[] = []
  let cursor = "0"

  do {
    const [nextCursor, keys] = await client.scan(
      cursor,
      "MATCH",
      pattern,
      "COUNT",
      100,
    )
    cursor = nextCursor
    for (const key of keys) {
      workerIds.push(key.slice(LIVENESS_PREFIX.length))
    }
  } while (cursor !== "0")

  return workerIds
}

export async function scanWorkerBeats(): Promise<WorkerBeat[]> {
  try {
    await ensureRedisConnected()
  } catch {
    return []
  }

  const client = getRedis()
  const pattern = `${BEAT_PREFIX}*`
  const beats: WorkerBeat[] = []
  let cursor = "0"

  do {
    const [nextCursor, keys] = await client.scan(
      cursor,
      "MATCH",
      pattern,
      "COUNT",
      100,
    )
    cursor = nextCursor
    for (const key of keys) {
      const workerId = key.slice(BEAT_PREFIX.length)
      const raw = await client.get(key)
      if (!raw) continue
      try {
        const payload = JSON.parse(raw) as WorkerBeatPayload
        beats.push({ workerId, ...payload })
      } catch {
        // Malformed beat payload — skip
      }
    }
  } while (cursor !== "0")

  return beats
}

export async function closeQueueConnections(): Promise<void> {
  if (queue) {
    await queue.close()
    queue = null
  }
  if (siteSyncQueue) {
    await siteSyncQueue.close()
    siteSyncQueue = null
  }
  if (cleanupQueue) {
    await cleanupQueue.close()
    cleanupQueue = null
  }
  if (redis) {
    await redis.quit()
    redis = null
  }
}
