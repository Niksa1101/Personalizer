"use client"

import {
  createQueueHealthPoller,
  DEFAULT_POLL_MS,
  type QueueHealthPoller,
  type QueueHealthPollerState,
} from "@/lib/queue-health-poller"

const SERVER_SNAPSHOT: QueueHealthPollerState = {
  health: null,
  connectivity: "unknown",
  sessionExpired: false,
  lastSuccessAt: null,
}

let poller: QueueHealthPoller | null = null
let cachedState: QueueHealthPollerState = SERVER_SNAPSHOT
let effectiveOptions = { pollMs: DEFAULT_POLL_MS, detail: false }
const subscribers = new Map<
  () => void,
  { pollMs: number; detail: boolean }
>()

function computeEffectiveOptions(): { pollMs: number; detail: boolean } {
  let pollMs = DEFAULT_POLL_MS
  let detail = false
  for (const opts of subscribers.values()) {
    pollMs = Math.min(pollMs, opts.pollMs)
    detail = detail || opts.detail
  }
  return { pollMs, detail }
}

function ensurePoller(): QueueHealthPoller {
  if (poller) return poller

  poller = createQueueHealthPoller(
    {
      fetchHealth(detail) {
        const url = detail
          ? "/api/queue/health?detail=1"
          : "/api/queue/health"
        return fetch(url, { cache: "no-store" })
      },
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
      now: () => Date.now(),
      document:
        typeof document !== "undefined"
          ? document
          : undefined,
      onState(state) {
        cachedState = state
        for (const callback of subscribers.keys()) {
          callback()
        }
      },
    },
    computeEffectiveOptions(),
  )
  poller.start()
  return poller
}

export function subscribeQueueHealth(
  callback: () => void,
  options: { pollMs: number; detail: boolean },
): () => void {
  subscribers.set(callback, options)
  const next = computeEffectiveOptions()

  if (subscribers.size === 1) {
    effectiveOptions = next
    ensurePoller()
  } else if (
    poller &&
    (next.pollMs !== effectiveOptions.pollMs ||
      next.detail !== effectiveOptions.detail)
  ) {
    effectiveOptions = next
    poller.setOptions(next)
  }

  return () => {
    subscribers.delete(callback)
    if (subscribers.size === 0) {
      poller?.stop()
      poller = null
      cachedState = SERVER_SNAPSHOT
      effectiveOptions = { pollMs: DEFAULT_POLL_MS, detail: false }
    } else {
      const next = computeEffectiveOptions()
      if (
        next.pollMs !== effectiveOptions.pollMs ||
        next.detail !== effectiveOptions.detail
      ) {
        effectiveOptions = next
        poller?.setOptions(next)
      }
    }
  }
}

export function getQueueHealthSnapshot(): QueueHealthPollerState {
  return cachedState
}

export function getQueueHealthServerSnapshot(): QueueHealthPollerState {
  return SERVER_SNAPSHOT
}
