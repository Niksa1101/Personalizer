import type { DashboardScope, DashboardSnapshot } from "@/lib/dashboard-types"

export type DashboardConnectivity = "live" | "polling" | "unreachable"

/** Must be >= 2 × server HEARTBEAT_MS (10 s in route.ts). */
export const SILENCE_MS = 25_000
const POLL_MS = 5_000
const MAX_SNAPSHOT_FAILURES = 5
const HIDDEN_TEARDOWN_MS = 60_000
const STREAM_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000]

export function buildStreamUrl(scope: DashboardScope): string {
  const params = new URLSearchParams()
  if (scope.campaignId) params.set("campaign", scope.campaignId)
  if (scope.includeArchived) params.set("archived", "1")
  const query = params.toString()
  return query
    ? `/api/stream/dashboard?${query}`
    : "/api/stream/dashboard"
}

export function buildSnapshotUrl(scope: DashboardScope): string {
  const params = new URLSearchParams({ once: "1" })
  if (scope.campaignId) params.set("campaign", scope.campaignId)
  if (scope.includeArchived) params.set("archived", "1")
  return `/api/stream/dashboard?${params.toString()}`
}

export function parseSseChunk(
  buffer: string,
  onEvent: (event: string, data: string) => void,
): string {
  const parts = buffer.split("\n\n")
  const remainder = parts.pop() ?? ""

  for (const part of parts) {
    if (!part.trim()) continue

    if (part.startsWith(":")) {
      continue
    }

    let event = "message"
    const dataLines: string[] = []

    for (const line of part.split("\n")) {
      if (line.startsWith("event:")) {
        event = line.slice(6).trim()
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trim())
      }
    }

    if (dataLines.length > 0) {
      onEvent(event, dataLines.join("\n"))
    }
  }

  return remainder
}

export type TimerHandle = ReturnType<typeof globalThis.setTimeout>

export type DashboardConnectionDeps = {
  scope: DashboardScope
  fetchStream: (url: string, signal: AbortSignal) => Promise<Response>
  fetchSnapshot: (url: string) => Promise<DashboardSnapshot>
  setTimeout: (fn: () => void, ms: number) => TimerHandle
  clearTimeout: (id: TimerHandle) => void
  setInterval: (fn: () => void, ms: number) => TimerHandle
  clearInterval: (id: TimerHandle) => void
  onSnapshot: (snapshot: DashboardSnapshot) => void
  onConnectivity: (connectivity: DashboardConnectivity) => void
  onWarn?: (message: string) => void
  document?: Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">
}

export type DashboardConnection = {
  stop: () => void
}

export function createDashboardConnection(
  deps: DashboardConnectionDeps,
): DashboardConnection {
  let cancelled = false
  let streamAbort: AbortController | null = null
  let pollTimer: ReturnType<typeof setInterval> | null = null
  let silenceTimer: ReturnType<typeof setTimeout> | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let hiddenTimer: ReturnType<typeof setTimeout> | null = null
  let reconnectAttempt = 0
  let snapshotFailures = 0
  let streamActive = false
  let connectivity: DashboardConnectivity = "live"

  const setConnectivity = (next: DashboardConnectivity) => {
    connectivity = next
    deps.onConnectivity(next)
  }

  const clearSilenceTimer = () => {
    if (silenceTimer) {
      deps.clearTimeout(silenceTimer)
      silenceTimer = null
    }
  }

  const resetSilenceTimer = () => {
    clearSilenceTimer()
    silenceTimer = deps.setTimeout(() => {
      if (cancelled) return
      stopStream()
      startPolling()
      scheduleReconnect()
    }, SILENCE_MS)
  }

  const stopPolling = () => {
    if (pollTimer) {
      deps.clearInterval(pollTimer)
      pollTimer = null
    }
  }

  const fetchSnapshotOnce = async (): Promise<boolean> => {
    try {
      const data = await deps.fetchSnapshot(buildSnapshotUrl(deps.scope))
      if (cancelled) return true
      deps.onSnapshot(data)
      snapshotFailures = 0
      // A snapshot that arrives IS proof the database is reachable, so this
      // clears `unreachable` — otherwise the banner outlived the outage and
      // claimed we couldn't reach the database over visibly fresh numbers.
      // `live` still wins: a poll landing after the stream recovered must not
      // demote the indicator.
      if (connectivity !== "live") {
        setConnectivity("polling")
      }
      return true
    } catch {
      snapshotFailures += 1
      if (snapshotFailures >= MAX_SNAPSHOT_FAILURES) {
        setConnectivity("unreachable")
      }
      return false
    }
  }

  const startPolling = () => {
    if (pollTimer) return
    if (connectivity !== "unreachable") {
      setConnectivity("polling")
    }
    void fetchSnapshotOnce()
    pollTimer = deps.setInterval(() => {
      void fetchSnapshotOnce()
    }, POLL_MS)
  }

  const stopStream = () => {
    streamActive = false
    streamAbort?.abort()
    streamAbort = null
    clearSilenceTimer()
  }

  const scheduleReconnect = () => {
    if (cancelled || reconnectTimer) return
    const delay =
      STREAM_BACKOFF_MS[
        Math.min(reconnectAttempt, STREAM_BACKOFF_MS.length - 1)
      ] ?? 10_000
    reconnectAttempt += 1
    reconnectTimer = deps.setTimeout(() => {
      reconnectTimer = null
      void connectStream()
    }, delay)
  }

  const connectStream = async () => {
    stopStream()
    const attemptAbort = new AbortController()
    streamAbort = attemptAbort

    try {
      const response = await deps.fetchStream(
        buildStreamUrl(deps.scope),
        attemptAbort.signal,
      )

      if (!response.ok || !response.body) {
        throw new Error(`Stream failed (${response.status})`)
      }

      reconnectAttempt = 0
      stopPolling()
      setConnectivity("live")
      streamActive = true
      resetSilenceTimer()

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""

        while (!cancelled) {
          const { done, value } = await reader.read()
          if (done) break

          resetSilenceTimer()

          if (value) {
            buffer += decoder.decode(value, { stream: true })
            buffer = parseSseChunk(buffer, (event, data) => {
              if (event === "snapshot") {
                deps.onSnapshot(JSON.parse(data) as DashboardSnapshot)
                snapshotFailures = 0
                stopPolling()
                setConnectivity("live")
              } else if (event === "overflow") {
                stopStream()
                startPolling()
              } else if (event === "error") {
                deps.onWarn?.(`Dashboard stream error event: ${data}`)
                stopStream()
                startPolling()
                scheduleReconnect()
              }
            })
          }
        }

        if (!cancelled) {
          stopStream()
          startPolling()
          scheduleReconnect()
        }
    } catch (error) {
      if (cancelled || attemptAbort.signal.aborted) return
      stopStream()
      startPolling()
      scheduleReconnect()
      if (error instanceof Error && error.name !== "AbortError") {
        deps.onWarn?.(`Dashboard stream error: ${error.message}`)
      }
    }
  }

  const onVisibilityChange = () => {
    const doc = deps.document
    if (!doc) return

    if (doc.visibilityState === "hidden") {
      hiddenTimer = deps.setTimeout(() => {
        stopStream()
        stopPolling()
        if (reconnectTimer) {
          deps.clearTimeout(reconnectTimer)
          reconnectTimer = null
        }
      }, HIDDEN_TEARDOWN_MS)
      return
    }

    if (hiddenTimer) {
      deps.clearTimeout(hiddenTimer)
      hiddenTimer = null
    }

    if (reconnectTimer) {
      deps.clearTimeout(reconnectTimer)
      reconnectTimer = null
    }

    stopPolling()
    void fetchSnapshotOnce().finally(() => {
      if (!cancelled && !streamActive) {
        void connectStream()
      }
    })
  }

  void connectStream()

  if (deps.document) {
    deps.document.addEventListener("visibilitychange", onVisibilityChange)
  }

  return {
    stop: () => {
      cancelled = true
      stopStream()
      stopPolling()
      clearSilenceTimer()
      if (reconnectTimer) deps.clearTimeout(reconnectTimer)
      if (hiddenTimer) deps.clearTimeout(hiddenTimer)
      deps.document?.removeEventListener("visibilitychange", onVisibilityChange)
    },
  }
}
