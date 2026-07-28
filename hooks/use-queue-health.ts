"use client"

import { useCallback, useSyncExternalStore } from "react"

import {
  DEFAULT_POLL_MS,
  type QueueHealthPollerState,
} from "@/lib/queue-health-poller"
import {
  getQueueHealthServerSnapshot,
  getQueueHealthSnapshot,
  subscribeQueueHealth,
} from "@/lib/queue-health-store"

export type QueueHealthState = QueueHealthPollerState

export { DEFAULT_POLL_MS, QUEUE_POLL_MS } from "@/lib/queue-health-poller"

export function useQueueHealth(options?: {
  pollMs?: number
  detail?: boolean
}): QueueHealthState {
  const pollMs = options?.pollMs ?? DEFAULT_POLL_MS
  const detail = options?.detail ?? false

  const subscribe = useCallback(
    (callback: () => void) =>
      subscribeQueueHealth(callback, { pollMs, detail }),
    [pollMs, detail],
  )

  return useSyncExternalStore(
    subscribe,
    getQueueHealthSnapshot,
    getQueueHealthServerSnapshot,
  )
}
