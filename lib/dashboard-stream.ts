import "server-only"

import {
  getDashboardSnapshot,
  scopeKey,
  type DashboardScope,
  type DashboardSnapshot,
} from "@/lib/dashboard"
import { getSupabaseAdmin } from "@/lib/supabase"

const MAX_SCOPES_PER_TICK = 8
const DEBOUNCE_MS = 400
const MAX_WAIT_MS = 1_200
const RESNAPSHOT_MS = 15_000
const CHANNEL_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000]

type StreamSubscriber = {
  enqueue: (snapshot: DashboardSnapshot) => void
  onOverflow: () => void
  signal: AbortSignal
}

type ScopeBucket = {
  scope: DashboardScope
  subs: Set<StreamSubscriber>
}

type DashboardStreamState = {
  channel: ReturnType<ReturnType<typeof getSupabaseAdmin>["channel"]> | null
  subscribers: Map<string, ScopeBucket>
  debounceTimer: ReturnType<typeof setTimeout> | null
  maxWaitTimer: ReturnType<typeof setTimeout> | null
  resnapshotTimer: ReturnType<typeof setInterval> | null
  tickInFlight: boolean
  tickQueued: boolean
  overflowLogged: boolean
  channelBackoffAttempt: number
  channelReconnectTimer: ReturnType<typeof setTimeout> | null
}

const GLOBAL_KEY = Symbol.for("personalizer.dashboardStream")

function getState(): DashboardStreamState {
  const globalStore = globalThis as typeof globalThis & {
    [GLOBAL_KEY]?: DashboardStreamState
  }

  if (!globalStore[GLOBAL_KEY]) {
    globalStore[GLOBAL_KEY] = {
      channel: null,
      subscribers: new Map(),
      debounceTimer: null,
      maxWaitTimer: null,
      resnapshotTimer: null,
      tickInFlight: false,
      tickQueued: false,
      overflowLogged: false,
      channelBackoffAttempt: 0,
      channelReconnectTimer: null,
    }
  }

  return globalStore[GLOBAL_KEY]!
}

function clearDebounce(state: DashboardStreamState): void {
  if (state.debounceTimer) {
    clearTimeout(state.debounceTimer)
    state.debounceTimer = null
  }
  if (state.maxWaitTimer) {
    clearTimeout(state.maxWaitTimer)
    state.maxWaitTimer = null
  }
}

function subscriberCount(state: DashboardStreamState): number {
  let total = 0
  for (const bucket of state.subscribers.values()) {
    total += bucket.subs.size
  }
  return total
}

function safeEnqueue(
  bucket: ScopeBucket,
  sub: StreamSubscriber,
  snapshot: DashboardSnapshot,
): void {
  try {
    sub.enqueue(snapshot)
  } catch {
    bucket.subs.delete(sub)
  }
}

async function pushSnapshots(state: DashboardStreamState): Promise<void> {
  if (state.tickInFlight) {
    state.tickQueued = true
    return
  }

  state.tickInFlight = true
  clearDebounce(state)

  try {
    const scopeKeys = [...state.subscribers.keys()]
    const overflowKeys = scopeKeys.slice(MAX_SCOPES_PER_TICK)
    const activeKeys = scopeKeys.slice(0, MAX_SCOPES_PER_TICK)

    if (overflowKeys.length > 0 && !state.overflowLogged) {
      state.overflowLogged = true
      console.warn(
        `Dashboard stream scope overflow: ${overflowKeys.length} scope(s) forced to polling`,
        { overflowKeys },
      )
    }

    for (const key of overflowKeys) {
      const bucket = state.subscribers.get(key)
      if (!bucket) continue
      for (const sub of bucket.subs) {
        sub.onOverflow()
      }
    }

    await Promise.all(
      activeKeys.map(async (key) => {
        const bucket = state.subscribers.get(key)
        if (!bucket) return
        const snapshot = await getDashboardSnapshot(bucket.scope)
        for (const sub of bucket.subs) {
          if (sub.signal.aborted) continue
          safeEnqueue(bucket, sub, snapshot)
        }
      }),
    )
  } catch (error) {
    console.error("Dashboard stream tick failed:", error)
  } finally {
    state.tickInFlight = false
    if (state.tickQueued) {
      state.tickQueued = false
      void pushSnapshots(state)
    }
  }
}

function scheduleTick(state: DashboardStreamState): void {
  if (state.debounceTimer) {
    clearTimeout(state.debounceTimer)
  } else if (!state.maxWaitTimer) {
    state.maxWaitTimer = setTimeout(() => {
      state.maxWaitTimer = null
      void pushSnapshots(state)
    }, MAX_WAIT_MS)
  }

  state.debounceTimer = setTimeout(() => {
    state.debounceTimer = null
    void pushSnapshots(state)
  }, DEBOUNCE_MS)
}

function clearResnapshotTimer(state: DashboardStreamState): void {
  if (state.resnapshotTimer) {
    clearInterval(state.resnapshotTimer)
    state.resnapshotTimer = null
  }
}

function ensureResnapshotTimer(state: DashboardStreamState): void {
  if (state.resnapshotTimer || subscriberCount(state) === 0) return

  state.resnapshotTimer = setInterval(() => {
    if (subscriberCount(state) === 0) {
      clearResnapshotTimer(state)
      return
    }
    void pushSnapshots(state)
  }, RESNAPSHOT_MS)
}

function removeChannel(state: DashboardStreamState): void {
  if (state.channelReconnectTimer) {
    clearTimeout(state.channelReconnectTimer)
    state.channelReconnectTimer = null
  }
  if (state.channel) {
    void getSupabaseAdmin().removeChannel(state.channel)
    state.channel = null
  }
}

function scheduleChannelReconnect(state: DashboardStreamState): void {
  if (state.channelReconnectTimer || subscriberCount(state) === 0) return

  const delay =
    CHANNEL_BACKOFF_MS[
      Math.min(state.channelBackoffAttempt, CHANNEL_BACKOFF_MS.length - 1)
    ] ?? 10_000
  state.channelBackoffAttempt += 1

  state.channelReconnectTimer = setTimeout(() => {
    state.channelReconnectTimer = null
    if (subscriberCount(state) === 0) return
    ensureChannel(state)
  }, delay)
}

function ensureChannel(state: DashboardStreamState): void {
  if (state.channel || subscriberCount(state) === 0) return

  const supabase = getSupabaseAdmin()
  const channel = supabase
    .channel("dashboard-realtime")
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "campaign_leads" },
      () => scheduleTick(state),
    )
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "pipeline_events" },
      () => scheduleTick(state),
    )
    .subscribe((status) => {
      if (status === "SUBSCRIBED") {
        state.channelBackoffAttempt = 0
        // Rows that changed while the channel was still joining were never
        // delivered — Realtime is not a replay log. Without this catch-up the
        // only recovery is the RESNAPSHOT_MS safety net, so a client that
        // connects just before a write can sit on stale numbers for 15 s.
        scheduleTick(state)
        return
      }

      if (
        status === "CHANNEL_ERROR" ||
        status === "TIMED_OUT" ||
        status === "CLOSED"
      ) {
        removeChannel(state)
        scheduleChannelReconnect(state)
      }
    })

  state.channel = channel
}

function teardownChannelIfIdle(state: DashboardStreamState): void {
  if (subscriberCount(state) > 0) return

  clearDebounce(state)
  clearResnapshotTimer(state)
  removeChannel(state)
  state.overflowLogged = false
  state.channelBackoffAttempt = 0
}

export function subscribeDashboardStream(
  scope: DashboardScope,
  subscriber: StreamSubscriber,
): () => void {
  const state = getState()
  const key = scopeKey(scope)

  let bucket = state.subscribers.get(key)
  if (!bucket) {
    bucket = { scope, subs: new Set() }
    state.subscribers.set(key, bucket)
  }
  bucket.subs.add(subscriber)

  // Both of these no-op while subscriberCount() is 0, so they must run *after*
  // the subscriber is registered — otherwise the first stream of a fresh
  // process gets no channel and no safety net, and reads Live over stale data.
  ensureChannel(state)
  ensureResnapshotTimer(state)

  return () => {
    bucket?.subs.delete(subscriber)
    if (bucket && bucket.subs.size === 0) {
      state.subscribers.delete(key)
    }
    teardownChannelIfIdle(state)
  }
}

export function encodeSseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

export function encodeSseComment(comment: string): string {
  return `: ${comment}\n\n`
}
