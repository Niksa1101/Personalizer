import "server-only"

import { Queue } from "bullmq"
import Redis from "ioredis"

import { assertEnv } from "@/lib/env"

export const PIPELINE_QUEUE_NAME = "pipeline"

const LIVENESS_PREFIX = "pz:worker:alive:"
const LIVENESS_TTL_SECONDS = 15
const LIVENESS_REFRESH_MS = 5_000

let redis: Redis | null = null
let queue: Queue | null = null

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

async function ensureQueueReady(): Promise<Queue> {
  await ensureRedisConnected()
  return getQueue()
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
 * The ONLY place queue.add is called. See docs/Tech.md §7.1.
 * Returns false when the prior remove failed because the job is locked —
 * BullMQ then silently drops the add with the same jobId.
 */
export async function enqueueLead(
  campaignLeadId: string,
  opts?: { delayMs?: number },
): Promise<boolean> {
  const q = await ensureQueueReady()

  let removable = true
  try {
    await q.remove(campaignLeadId)
  } catch {
    // Locked — the following add with the same jobId will no-op.
    removable = false
  }

  await q.add(
    "process-lead",
    { campaignLeadId },
    {
      jobId: campaignLeadId,
      delay: opts?.delayMs,
      removeOnComplete: 100,
      removeOnFail: false,
    },
  )

  return removable
}

function livenessKey(workerId: string): string {
  return `${LIVENESS_PREFIX}${workerId}`
}

export async function registerLiveness(workerId: string): Promise<void> {
  await ensureRedisConnected()
  await getRedis().set(livenessKey(workerId), "1", "EX", LIVENESS_TTL_SECONDS)
}

export async function refreshLiveness(workerId: string): Promise<void> {
  await getRedis().set(livenessKey(workerId), "1", "EX", LIVENESS_TTL_SECONDS)
}

export async function deleteLiveness(workerId: string): Promise<void> {
  await getRedis().del(livenessKey(workerId))
}

export function startLivenessRefresh(workerId: string): () => void {
  const timer = setInterval(() => {
    void refreshLiveness(workerId).catch((error) => {
      console.error("[worker] liveness refresh failed:", error)
    })
  }, LIVENESS_REFRESH_MS)

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

export async function closeQueueConnections(): Promise<void> {
  if (queue) {
    await queue.close()
    queue = null
  }
  if (redis) {
    await redis.quit()
    redis = null
  }
}
