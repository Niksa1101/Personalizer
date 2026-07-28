import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  createQueueHealthPoller,
  DEFAULT_POLL_MS,
  MAX_CONSECUTIVE_MISSES,
  type TimerHandle,
} from "@/lib/queue-health-poller"

/**
 * A tick drains every timer that is due at the new `now`, including timers
 * scheduled *during* the tick. Without that, a poller that reschedules at 0ms
 * would still fire once per tick() call and the request-count assertions could
 * only ever catch polling that is too slow — never polling that is too fast.
 * The bound turns a self-retriggering timer into a test failure instead of a
 * hang.
 */
const MAX_TIMERS_PER_TICK = 64

type FakeClock = {
  timers: Array<{ id: TimerHandle; at: number; fn: () => void }>
  nextId: number
  now: number
  setTimeout: (fn: () => void, ms: number) => TimerHandle
  clearTimeout: (id: TimerHandle) => void
  tick: (ms: number) => Promise<void>
}

function createFakeClock(startMs = 0): FakeClock {
  const clock: FakeClock = {
    timers: [],
    nextId: 1,
    now: startMs,
    setTimeout(fn, ms) {
      const id = clock.nextId++ as unknown as TimerHandle
      clock.timers.push({ id, at: clock.now + ms, fn })
      return id
    },
    clearTimeout(id) {
      clock.timers = clock.timers.filter((timer) => timer.id !== id)
    },
    async tick(ms) {
      clock.now += ms
      let fired = 0
      for (;;) {
        // Let the callback's own async work settle so a timer it schedules is
        // visible to this loop before we decide the tick is done.
        await new Promise((resolve) => setImmediate(resolve))
        const [next] = clock.timers
          .filter((timer) => timer.at <= clock.now)
          .sort((a, b) => a.at - b.at)
        if (!next) return
        clock.timers = clock.timers.filter((timer) => timer.id !== next.id)
        fired += 1
        if (fired > MAX_TIMERS_PER_TICK) {
          throw new Error(
            `fake clock fired ${fired} timers within tick(${ms}) — ` +
              "something is rescheduling with no delay",
          )
        }
        await next.fn()
      }
    },
  }
  return clock
}

describe("createQueueHealthPoller", () => {
  it("60s at pollMs=5000 yields exactly 12 requests", async () => {
    const clock = createFakeClock()
    let requests = 0
    const poller = createQueueHealthPoller(
      {
        fetchHealth: async () => {
          requests += 1
          return new Response(JSON.stringify({ redis: "up", workers: [] }), {
            status: 200,
          })
        },
        setTimeout: clock.setTimeout.bind(clock),
        clearTimeout: clock.clearTimeout.bind(clock),
        now: () => clock.now,
        onState: () => {},
      },
      { pollMs: 5_000, detail: false },
    )

    poller.start()
    await new Promise((resolve) => setImmediate(resolve))
    for (let i = 1; i < 12; i++) {
      await clock.tick(5_000)
    }
    poller.stop()
    assert.equal(requests, 12)
  })

  it("setOptions reschedules without an immediate fetch", async () => {
    const clock = createFakeClock()
    let requests = 0
    const poller = createQueueHealthPoller(
      {
        fetchHealth: async () => {
          requests += 1
          return new Response("{}", { status: 200 })
        },
        setTimeout: clock.setTimeout.bind(clock),
        clearTimeout: clock.clearTimeout.bind(clock),
        now: () => clock.now,
        onState: () => {},
      },
      { pollMs: DEFAULT_POLL_MS, detail: false },
    )

    poller.start()
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(requests, 1)
    poller.setOptions({ pollMs: 1_000, detail: false })
    assert.equal(requests, 1)
    await clock.tick(1_000)
    assert.equal(requests, 2)
    poller.stop()
  })

  it("rejected fetch produces no unhandled rejection", async () => {
    const clock = createFakeClock()
    const rejections: unknown[] = []
    const onRejection = (reason: unknown) => rejections.push(reason)
    process.on("unhandledRejection", onRejection)

    const poller = createQueueHealthPoller(
      {
        fetchHealth: async () => {
          throw new Error("network down")
        },
        setTimeout: clock.setTimeout.bind(clock),
        clearTimeout: clock.clearTimeout.bind(clock),
        now: () => clock.now,
        onState: () => {},
      },
      { pollMs: 1_000, detail: false },
    )

    poller.start()
    await clock.tick(0)
    await clock.tick(1_000)
    poller.stop()
    process.off("unhandledRejection", onRejection)
    assert.equal(rejections.length, 0)
  })

  it("401 freezes the request count", async () => {
    const clock = createFakeClock()
    let requests = 0
    const poller = createQueueHealthPoller(
      {
        fetchHealth: async () => {
          requests += 1
          return new Response("{}", { status: 401 })
        },
        setTimeout: clock.setTimeout.bind(clock),
        clearTimeout: clock.clearTimeout.bind(clock),
        now: () => clock.now,
        onState: () => {},
      },
      { pollMs: 1_000, detail: false },
    )

    poller.start()
    await new Promise((resolve) => setImmediate(resolve))
    await clock.tick(5_000)
    poller.stop()
    assert.equal(requests, 1)
  })

  it("misses flip connectivity after MAX_CONSECUTIVE_MISSES", async () => {
    const clock = createFakeClock()
    let connectivity: string | undefined
    const poller = createQueueHealthPoller(
      {
        fetchHealth: async () => {
          throw new Error("down")
        },
        setTimeout: clock.setTimeout.bind(clock),
        clearTimeout: clock.clearTimeout.bind(clock),
        now: () => clock.now,
        onState: (state) => {
          connectivity = state.connectivity
        },
      },
      { pollMs: 1_000, detail: false },
    )

    poller.start()
    for (let i = 0; i < MAX_CONSECUTIVE_MISSES; i++) {
      if (i === 0) {
        await new Promise((resolve) => setImmediate(resolve))
      } else {
        await clock.tick(1_000)
      }
    }
    poller.stop()
    assert.equal(connectivity, "unknown")
  })
})
