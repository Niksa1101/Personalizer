import { randomUUID } from "node:crypto"

import type Redis from "ioredis"

import { assertRedisConnected, getRedis } from "@/lib/queue"

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

export type RedisLockHandle = {
  token: string
  key: string
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

/** Returns null when the lock could not be taken within waitMs. */
export async function acquireRedisLock(opts: {
  key: string
  ttlMs: number
  renewMs: number
  waitMs: number
  pollMs?: number
  redis?: Redis
  signal?: AbortSignal
  label?: string
}): Promise<RedisLockHandle | null> {
  if (!opts.redis) {
    await assertRedisConnected()
  }
  const redis = opts.redis ?? getRedis()
  const pollMs = opts.pollMs ?? 200
  const deadline = Date.now() + opts.waitMs
  const label = opts.label ?? opts.key

  let token: string | null = null
  for (;;) {
    const candidate = randomUUID()
    const acquired = await redis.set(
      opts.key,
      candidate,
      "PX",
      opts.ttlMs,
      "NX",
    )
    if (acquired === "OK") {
      token = candidate
      break
    }
    if (opts.waitMs <= 0 || Date.now() >= deadline) break
    await sleep(pollMs, opts.signal)
  }

  if (!token) return null

  return {
    token,
    key: opts.key,
    release: async () => {
      await redis.eval(RELEASE_LUA, 1, opts.key, token!)
    },
    startRenewal: () => {
      const timer = setInterval(() => {
        void redis
          .eval(RENEW_LUA, 1, opts.key, token!, String(opts.ttlMs))
          .then((renewed) => {
            if (renewed !== 1) {
              console.error(`[redis-lock] renewal failed — lock lost for ${label}`)
            }
          })
      }, opts.renewMs)

      return () => clearInterval(timer)
    },
  }
}

export { RELEASE_LUA, RENEW_LUA }
