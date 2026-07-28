import assert from "node:assert/strict"
import { afterEach, describe, it } from "node:test"

import {
  getQueueHealthSnapshot,
  getQueueHealthServerSnapshot,
  subscribeQueueHealth,
} from "@/lib/queue-health-store"

const originalFetch = globalThis.fetch
const unsubscribers: Array<() => void> = []
let fetchCount = 0

afterEach(() => {
  for (const unsub of unsubscribers.splice(0)) {
    unsub()
  }
  globalThis.fetch = originalFetch
  fetchCount = 0
})

function installFetchMock() {
  globalThis.fetch = (async () => {
    fetchCount += 1
    return new Response(
      JSON.stringify({
        redis: "up",
        workers: [],
        pipelinePaused: false,
        dryRun: false,
        hasStaleActive: false,
        counts: { queuedDepth: 0, delayed: 0, active: 0 },
        siteSync: { depth: 0, active: 0, lastResult: "unknown" },
        serverNow: new Date().toISOString(),
      }),
      { status: 200 },
    )
  }) as typeof fetch
}

describe("queue-health-store", () => {
  it("shares one poller across multiple subscribers", async () => {
    installFetchMock()
    unsubscribers.push(
      subscribeQueueHealth(() => {}, { pollMs: 10_000, detail: false }),
      subscribeQueueHealth(() => {}, { pollMs: 2_000, detail: true }),
      subscribeQueueHealth(() => {}, { pollMs: 5_000, detail: false }),
    )

    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.ok(fetchCount >= 1)
    assert.equal(getQueueHealthServerSnapshot().connectivity, "unknown")
  })

  it("last unsubscribe resets snapshot; resubscribe starts fresh", async () => {
    installFetchMock()
    const unsub = subscribeQueueHealth(() => {}, {
      pollMs: 5_000,
      detail: false,
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    const firstBatch = fetchCount
    unsub()
    assert.deepEqual(getQueueHealthSnapshot(), getQueueHealthServerSnapshot())

    unsubscribers.push(
      subscribeQueueHealth(() => {}, { pollMs: 5_000, detail: false }),
    )
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.ok(fetchCount > firstBatch)
  })
})
