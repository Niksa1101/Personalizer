import { strict as assert } from "node:assert"
import { describe, it } from "node:test"

import type { DashboardSnapshot } from "@/lib/dashboard-types"

import {
  createDashboardConnection,
  parseSseChunk,
  SILENCE_MS,
  type DashboardConnectivity,
  type TimerHandle,
} from "./dashboard-connection"

const scope = { campaignId: null, includeArchived: false }

function emptySnapshot(): DashboardSnapshot {
  return {
    scope,
    tiles: {
      queued: 0,
      processing: 0,
      paused: 0,
      deployed: 0,
      ready: 0,
      failed: 0,
      skipped: 0,
    },
    dryRunCount: 0,
    buckets: [],
    batches: [],
    batchesTotal: 0,
    processing: [],
    processingTotal: 0,
    pausedCampaigns: [],
    generatedAt: new Date().toISOString(),
    screenState: "idle",
  }
}

type FakeClock = {
  now: () => number
  timers: Array<{ id: TimerHandle; at: number; fn: () => void; kind: "timeout" | "interval" }>
  nextId: number
  setTimeout: (fn: () => void, ms: number) => TimerHandle
  clearTimeout: (id: TimerHandle) => void
  setInterval: (fn: () => void, ms: number) => TimerHandle
  clearInterval: (id: TimerHandle) => void
  tick: (ms: number) => void
}

function createFakeClock(startMs = 0): FakeClock {
  let currentMs = startMs
  const clock: FakeClock = {
    now: () => currentMs,
    timers: [],
    nextId: 1,
    setTimeout(fn, ms) {
      const id = clock.nextId++ as unknown as TimerHandle
      clock.timers.push({ id, at: currentMs + ms, fn, kind: "timeout" })
      return id
    },
    clearTimeout(id) {
      clock.timers = clock.timers.filter((timer) => timer.id !== id)
    },
    setInterval(fn, ms) {
      const id = clock.nextId++ as unknown as TimerHandle
      clock.timers.push({ id, at: currentMs + ms, fn, kind: "interval" })
      return id
    },
    clearInterval(id) {
      clock.timers = clock.timers.filter((timer) => timer.id !== id)
    },
    tick(ms) {
      currentMs += ms
      const due = clock.timers
        .filter((timer) => timer.at <= currentMs)
        .sort((a, b) => a.at - b.at)
      for (const timer of due) {
        timer.fn()
        if (timer.kind === "interval") {
          timer.at = currentMs + 5_000
        } else {
          clock.timers = clock.timers.filter((entry) => entry.id !== timer.id)
        }
      }
    },
  }
  return clock
}

function hangingStream(initialChunks: Uint8Array[] = []) {
  let index = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < initialChunks.length) {
        controller.enqueue(initialChunks[index]!)
        index += 1
        return
      }
      // Stay open with no further bytes — exercises silence timer.
    },
  })
}

/** Open stream whose bytes are emitted on demand, so chunks can land at a
 *  chosen point on the fake clock rather than all at t=0. */
function controlledStream() {
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c
    },
  })
  return {
    stream,
    push: (text: string) => {
      controller?.enqueue(new TextEncoder().encode(text))
    },
  }
}

describe("parseSseChunk", () => {
  it("ignores comment-only chunks without emitting events", () => {
    const events: string[] = []
    const remainder = parseSseChunk(": ping\n\n", (event) => {
      events.push(event)
    })
    assert.deepEqual(events, [])
    assert.equal(remainder, "")
  })
})

describe("createDashboardConnection", () => {
  async function flushAsync(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }

  it("keeps live connectivity when comment-only chunks reset silence", async () => {
    // A heartbeat comment must count as liveness. The ping deliberately lands
    // *after* the connect-time silence deadline is already ticking, and the
    // assertion runs past that original deadline — otherwise the test passes
    // even when comments are dropped before resetting the timer.
    const clock = createFakeClock()
    const connectivity: DashboardConnectivity[] = []
    const stream = controlledStream()

    const connection = createDashboardConnection({
      scope,
      fetchStream: async () => new Response(stream.stream, { status: 200 }),
      fetchSnapshot: async () => emptySnapshot(),
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      setInterval: clock.setInterval,
      clearInterval: clock.clearInterval,
      now: clock.now,
      onSnapshot: () => {},
      onConnectivity: (state) => connectivity.push(state),
    })

    await flushAsync()

    // t = 20s: still inside the original 25s deadline.
    clock.tick(20_000)
    assert.ok(!connectivity.includes("polling"), "fell back before any silence")

    // Heartbeat arrives and must push the deadline out to t = 45s.
    stream.push(": ping\n\n")
    await flushAsync()

    // t = 30s: past the original deadline, well inside the reset one.
    clock.tick(10_000)
    assert.ok(
      !connectivity.includes("polling"),
      "heartbeat comment did not reset the silence timer",
    )

    connection.stop()
  })

  it("falls back to polling and schedules reconnect after silence", async () => {
    const clock = createFakeClock()
    const connectivity: DashboardConnectivity[] = []
    let reconnectAttempts = 0

    const connection = createDashboardConnection({
      scope,
      fetchStream: async () => {
        reconnectAttempts += 1
        return new Response(hangingStream([new TextEncoder().encode(": ping\n\n")]), {
          status: 200,
        })
      },
      fetchSnapshot: async () => emptySnapshot(),
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      setInterval: clock.setInterval,
      clearInterval: clock.clearInterval,
      now: clock.now,
      onSnapshot: () => {},
      onConnectivity: (state) => connectivity.push(state),
    })

    await flushAsync()
    clock.tick(SILENCE_MS + 1)
    assert.ok(connectivity.includes("polling"))

    clock.tick(1_000)
    await flushAsync()
    assert.ok(reconnectAttempts >= 2)

    connection.stop()
  })

  it("stops polling after a successful reconnect and keeps live sticky", async () => {
    const clock = createFakeClock()
    const connectivity: DashboardConnectivity[] = []
    let snapshotCalls = 0
    let streamOpens = 0

    const snapshotEvent = new TextEncoder().encode(
      'event: snapshot\ndata: {"generatedAt":"2026-01-01T00:00:00.000Z"}\n\n',
    )

    const connection = createDashboardConnection({
      scope,
      fetchStream: async () => {
        streamOpens += 1
        if (streamOpens === 1) {
          return new Response(hangingStream([new TextEncoder().encode(": ping\n\n")]), {
            status: 200,
          })
        }
        return new Response(hangingStream([snapshotEvent]), { status: 200 })
      },
      fetchSnapshot: async () => {
        snapshotCalls += 1
        return emptySnapshot()
      },
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      setInterval: clock.setInterval,
      clearInterval: clock.clearInterval,
      now: clock.now,
      onSnapshot: () => {},
      onConnectivity: (state) => connectivity.push(state),
    })

    await flushAsync()
    clock.tick(SILENCE_MS + 1)
    const pollsDuringFallback = snapshotCalls

    clock.tick(1_000)
    await flushAsync()
    clock.tick(5_000)

    assert.equal(connectivity.at(-1), "live")
    assert.equal(snapshotCalls, pollsDuringFallback)

    connection.stop()
  })

  it("does not throw when abort happens mid-read", async () => {
    const abortRef: { current: AbortController | null } = { current: null }

    const connection = createDashboardConnection({
      scope,
      fetchStream: async (_url, signal) => {
        abortRef.current = new AbortController()
        const merged = AbortSignal.any([signal, abortRef.current.signal])
        return new Response(
          new ReadableStream({
            async pull(controller) {
              await new Promise((resolve) => setTimeout(resolve, 10))
              if (merged.aborted) {
                controller.error(new DOMException("Aborted", "AbortError"))
                return
              }
              controller.enqueue(new TextEncoder().encode(": ping\n\n"))
            },
          }),
          { status: 200 },
        )
      },
      fetchSnapshot: async () => emptySnapshot(),
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
      setInterval: globalThis.setInterval,
      clearInterval: globalThis.clearInterval,
      now: () => Date.now(),
      onSnapshot: () => {},
      onConnectivity: () => {},
    })

    await new Promise((resolve) => setTimeout(resolve, 20))
    abortRef.current?.abort()
    await new Promise((resolve) => setTimeout(resolve, 20))

    connection.stop()
  })
})
