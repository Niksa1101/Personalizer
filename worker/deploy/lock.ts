import { randomUUID } from "node:crypto"

import type Redis from "ioredis"

import { assertEnv } from "@/lib/env"
import { getRedis } from "@/lib/queue"

const LOCK_TTL_MS = 120_000
const LOCK_RENEW_MS = 30_000
const LOCK_WAIT_MS = 60_000
const LOCK_POLL_MS = 200

const RELEASE_LUA = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
`

const RENEW_LUA = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("pexpire", KEYS[1], ARGV[2])
else
  return 0
end
`

export function deployLockKey(siteId: string): string {
  return `pz:deploy:lock:${siteId}`
}

export type DeployLockHandle = {
  token: string
  siteId: string
  release: () => Promise<void>
  startRenewal: () => () => void
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("Aborted"))
      return
    }
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer)
        reject(signal.reason ?? new Error("Aborted"))
      },
      { once: true },
    )
  })
}

async function releaseDeployLock(
  redis: Redis,
  siteId: string,
  token: string,
): Promise<void> {
  await redis.eval(RELEASE_LUA, 1, deployLockKey(siteId), token)
}

async function renewDeployLock(
  redis: Redis,
  siteId: string,
  token: string,
): Promise<boolean> {
  const result = await redis.eval(
    RENEW_LUA,
    1,
    deployLockKey(siteId),
    token,
    String(LOCK_TTL_MS),
  )
  return result === 1
}

export async function acquireDeployLock(opts?: {
  siteId?: string
  redis?: Redis
  waitMs?: number
  signal?: AbortSignal
}): Promise<DeployLockHandle> {
  const siteId = opts?.siteId ?? assertEnv().NETLIFY_SITE_ID
  const redis = opts?.redis ?? getRedis()
  const waitMs = opts?.waitMs ?? LOCK_WAIT_MS
  const signal = opts?.signal
  const key = deployLockKey(siteId)
  const deadline = Date.now() + waitMs

  let token: string | null = null
  while (Date.now() < deadline) {
    const candidate = randomUUID()
    const acquired = await redis.set(key, candidate, "PX", LOCK_TTL_MS, "NX")
    if (acquired === "OK") {
      token = candidate
      break
    }
    await sleep(LOCK_POLL_MS, signal)
  }

  if (!token) {
    throw new Error(
      `Timed out waiting for deploy lock on site ${siteId} after ${waitMs}ms`,
    )
  }

  return {
    token,
    siteId,
    release: async () => {
      await releaseDeployLock(redis, siteId, token!)
    },
    startRenewal: () => {
      const timer = setInterval(() => {
        void renewDeployLock(redis, siteId, token!).then((renewed) => {
          if (!renewed) {
            console.error(
              `[deploy-lock] renewal failed — lock lost for site ${siteId}`,
            )
          }
        })
      }, LOCK_RENEW_MS)

      return () => clearInterval(timer)
    },
  }
}

export const deployLockConstants = {
  LOCK_TTL_MS,
  LOCK_RENEW_MS,
  LOCK_WAIT_MS,
} as const
