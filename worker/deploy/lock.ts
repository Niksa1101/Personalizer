import type Redis from "ioredis"

import { acquireRedisLock } from "@/lib/redis-lock"
import { assertEnv } from "@/lib/env"
import { getRedis } from "@/lib/queue"

const LOCK_TTL_MS = 120_000
const LOCK_RENEW_MS = 30_000
const LOCK_WAIT_MS = 60_000

export function deployLockKey(siteId: string): string {
  return `pz:deploy:lock:${siteId}`
}

export type DeployLockHandle = {
  token: string
  siteId: string
  release: () => Promise<void>
  startRenewal: () => () => void
}

export async function acquireDeployLock(opts?: {
  siteId?: string
  redis?: Redis
  waitMs?: number
  signal?: AbortSignal
}): Promise<DeployLockHandle> {
  const siteId = opts?.siteId ?? assertEnv().NETLIFY_SITE_ID
  const waitMs = opts?.waitMs ?? LOCK_WAIT_MS
  const result = await acquireRedisLock({
    key: deployLockKey(siteId),
    ttlMs: LOCK_TTL_MS,
    renewMs: LOCK_RENEW_MS,
    waitMs,
    redis: opts?.redis ?? getRedis(),
    signal: opts?.signal,
    label: `deploy site ${siteId}`,
  })

  if (!result) {
    throw new Error(
      `Timed out waiting for deploy lock on site ${siteId} after ${waitMs}ms`,
    )
  }

  const token = result.token
  return {
    token,
    siteId,
    release: result.release,
    startRenewal: result.startRenewal,
  }
}

export const deployLockConstants = {
  LOCK_TTL_MS,
  LOCK_RENEW_MS,
  LOCK_WAIT_MS,
} as const
