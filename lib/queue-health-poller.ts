import type { QueueHealth } from "@/lib/queue-health"

export const QUEUE_POLL_MS = 2_000
export const DEFAULT_POLL_MS = 5_000
export const DEGRADE_AFTER_MS = 8_000
export const MAX_CONSECUTIVE_MISSES = 2

export type QueueHealthConnectivity = "live" | "unknown"

export type QueueHealthPollerState = {
  health: QueueHealth | null
  connectivity: QueueHealthConnectivity
  sessionExpired: boolean
  lastSuccessAt: number | null
}

export type QueueHealthPollerOptions = {
  pollMs: number
  detail: boolean
}

export type TimerHandle = ReturnType<typeof globalThis.setTimeout>

export type QueueHealthPollerDeps = {
  fetchHealth: (detail: boolean) => Promise<Response>
  setTimeout: (fn: () => void, ms: number) => TimerHandle
  clearTimeout: (id: TimerHandle) => void
  now: () => number
  document?: Pick<
    Document,
    "hidden" | "addEventListener" | "removeEventListener"
  >
  onState: (state: QueueHealthPollerState) => void
}

export type QueueHealthPoller = {
  start: () => void
  stop: () => void
  setOptions: (options: QueueHealthPollerOptions) => void
  getState: () => QueueHealthPollerState
}

export function createQueueHealthPoller(
  deps: QueueHealthPollerDeps,
  initialOptions: QueueHealthPollerOptions = {
    pollMs: DEFAULT_POLL_MS,
    detail: false,
  },
): QueueHealthPoller {
  let options = { ...initialOptions }
  let stopped = true
  let pendingTimer: TimerHandle | null = null
  let inFlight: Promise<void> | null = null
  let consecutiveMisses = 0
  let lastSuccessAt: number | null = null
  let health: QueueHealth | null = null
  let connectivity: QueueHealthConnectivity = "unknown"
  let sessionExpired = false

  const emit = () => {
    deps.onState({
      health,
      connectivity,
      sessionExpired,
      lastSuccessAt,
    })
  }

  const clearPending = () => {
    if (pendingTimer != null) {
      deps.clearTimeout(pendingTimer)
      pendingTimer = null
    }
  }

  const scheduleNext = (delayMs: number) => {
    if (stopped) return
    if (deps.document?.hidden) return
    clearPending()
    pendingTimer = deps.setTimeout(() => {
      pendingTimer = null
      void runCycle()
    }, delayMs)
  }

  const runCycle = async (): Promise<void> => {
    if (stopped || sessionExpired) return
    if (inFlight) return

    inFlight = (async () => {
      try {
        const response = await deps.fetchHealth(options.detail)
        if (response.status === 401) {
          sessionExpired = true
          connectivity = "unknown"
          emit()
          stop()
          return
        }
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`)
        }

        health = (await response.json()) as QueueHealth
        consecutiveMisses = 0
        lastSuccessAt = deps.now()
        connectivity = "live"
        emit()
      } catch {
        consecutiveMisses += 1
        const elapsed =
          lastSuccessAt != null ? deps.now() - lastSuccessAt : Infinity
        if (
          consecutiveMisses >= MAX_CONSECUTIVE_MISSES ||
          elapsed >= DEGRADE_AFTER_MS
        ) {
          connectivity = "unknown"
          emit()
        }
      } finally {
        inFlight = null
        if (!stopped && !sessionExpired) {
          scheduleNext(options.pollMs)
        }
      }
    })()

    await inFlight
  }

  const handleVisibility = () => {
    if (deps.document?.hidden) {
      clearPending()
      return
    }
    void runCycle()
  }

  function start() {
    if (!stopped) return
    stopped = false
    consecutiveMisses = 0
    deps.document?.addEventListener("visibilitychange", handleVisibility)
    void runCycle()
  }

  function stop() {
    stopped = true
    clearPending()
    deps.document?.removeEventListener("visibilitychange", handleVisibility)
  }

  function setOptions(next: QueueHealthPollerOptions) {
    options = { ...next }
    if (stopped) return
    clearPending()
    scheduleNext(options.pollMs)
  }

  function getState(): QueueHealthPollerState {
    return { health, connectivity, sessionExpired, lastSuccessAt }
  }

  return { start, stop, setOptions, getState }
}
