import { strict as assert } from "node:assert"
import { describe, it } from "node:test"

import {
  acquireDeployLock,
  deployLockKey,
} from "@/worker/deploy/lock"

type FakeRedisState = {
  values: Map<string, string>
  ttls: Map<string, number>
}

function createFakeRedis(): FakeRedisState & {
  set: (
    key: string,
    value: string,
    mode?: string,
    ttl?: number,
    nx?: string,
  ) => Promise<string | null>
  get: (key: string) => Promise<string | null>
  eval: (
    script: string,
    numKeys: number,
    key: string,
    ...args: string[]
  ) => Promise<number>
} {
  const state: FakeRedisState = {
    values: new Map(),
    ttls: new Map(),
  }

  return {
    ...state,
    async set(key, value, mode, ttl, nx) {
      if (nx === "NX" && state.values.has(key)) {
        return null
      }
      state.values.set(key, value)
      if (mode === "PX" && typeof ttl === "number") {
        state.ttls.set(key, ttl)
      }
      return "OK"
    },
    async get(key) {
      return state.values.get(key) ?? null
    },
    async eval(_script, _numKeys, key, token, ttlMs) {
      const current = state.values.get(key)
      if (current !== token) return 0
      if (ttlMs != null) {
        state.ttls.set(key, Number(ttlMs))
        return 1
      }
      state.values.delete(key)
      state.ttls.delete(key)
      return 1
    },
  }
}

describe("deploy lock", () => {
  it("uses a site-scoped key", () => {
    assert.equal(deployLockKey("abc-123"), "pz:deploy:lock:abc-123")
  })

  it("acquires exclusively and releases with token check", async () => {
    const redis = createFakeRedis()
    const first = await acquireDeployLock({
      siteId: "site-a",
      redis: redis as never,
      waitMs: 500,
    })
    assert.ok(first.token)

    let secondError: unknown = null
    await acquireDeployLock({
      siteId: "site-a",
      redis: redis as never,
      waitMs: 100,
    }).catch((error: unknown) => {
      secondError = error
    })
    assert.ok(secondError instanceof Error)
    assert.match(secondError.message, /Timed out waiting for deploy lock/)

    await first.release()
    const second = await acquireDeployLock({
      siteId: "site-a",
      redis: redis as never,
      waitMs: 500,
    })
    assert.notEqual(second.token, first.token)
    await second.release()
  })

  it("does not release a lock held by another token", async () => {
    const redis = createFakeRedis()
    const handle = await acquireDeployLock({
      siteId: "site-b",
      redis: redis as never,
      waitMs: 500,
    })

    const key = deployLockKey("site-b")
    redis.values.set(key, "other-token")

    await handle.release()
    assert.equal(await redis.get(key), "other-token")
    redis.values.delete(key)
  })
})
