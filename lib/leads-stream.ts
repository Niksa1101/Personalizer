import "server-only"

import {
  leadStreamScopeKey,
  type LeadStreamScope,
} from "@/lib/lead-filters"
import { getSupabaseAdmin } from "@/lib/supabase"
import type { Database } from "@/lib/database.types"

const DEBOUNCE_MS = 250
const CHANNEL_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000]
const MAX_CHANNEL_BACKOFF_ATTEMPTS = CHANNEL_BACKOFF_MS.length

type PipelineEventRow = Database["public"]["Tables"]["pipeline_events"]["Row"]

type PendingInsert = {
  id: string
  campaignId: string
}

type LeadsStreamSubscriber = {
  scope: LeadStreamScope
  enqueueChanged: (payload: { ids: string[]; inserted: string[] }) => void
  enqueueEvent: (event: PipelineEventRow) => void
  enqueueResync: () => void
  onError: (message: string) => void
  signal: AbortSignal
}

type LeadsStreamState = {
  channel: ReturnType<ReturnType<typeof getSupabaseAdmin>["channel"]> | null
  subscribers: Set<LeadsStreamSubscriber>
  debounceTimer: ReturnType<typeof setTimeout> | null
  pendingLeadIds: Set<string>
  pendingInserts: PendingInsert[]
  channelBackoffAttempt: number
  channelReconnectTimer: ReturnType<typeof setTimeout> | null
}

const GLOBAL_KEY = Symbol.for("personalizer.leadsStream")

function getState(): LeadsStreamState {
  const globalStore = globalThis as typeof globalThis & {
    [GLOBAL_KEY]?: LeadsStreamState
  }

  if (!globalStore[GLOBAL_KEY]) {
    globalStore[GLOBAL_KEY] = {
      channel: null,
      subscribers: new Set(),
      debounceTimer: null,
      pendingLeadIds: new Set(),
      pendingInserts: [],
      channelBackoffAttempt: 0,
      channelReconnectTimer: null,
    }
  }

  return globalStore[GLOBAL_KEY]!
}

function subscriberCount(state: LeadsStreamState): number {
  return state.subscribers.size
}

function insertMatchesScope(
  insert: PendingInsert,
  scope: LeadStreamScope,
): boolean {
  if (scope.campaignId && insert.campaignId !== scope.campaignId) {
    return false
  }
  return true
}

function flushPending(state: LeadsStreamState): void {
  if (state.pendingLeadIds.size === 0 && state.pendingInserts.length === 0) {
    return
  }

  const ids = [...state.pendingLeadIds]
  const inserts = [...state.pendingInserts]
  state.pendingLeadIds.clear()
  state.pendingInserts = []

  for (const sub of state.subscribers) {
    if (sub.signal.aborted) continue
    const scopedInserts = inserts
      .filter((insert) => insertMatchesScope(insert, sub.scope))
      .map((insert) => insert.id)
    try {
      sub.enqueueChanged({ ids, inserted: scopedInserts })
    } catch {
      state.subscribers.delete(sub)
    }
  }
}

function emitResync(state: LeadsStreamState): void {
  for (const sub of state.subscribers) {
    if (sub.signal.aborted) continue
    try {
      sub.enqueueResync()
    } catch {
      state.subscribers.delete(sub)
    }
  }
}

function notifyChannelError(state: LeadsStreamState, message: string): void {
  for (const sub of state.subscribers) {
    if (sub.signal.aborted) continue
    try {
      sub.onError(message)
    } catch {
      state.subscribers.delete(sub)
    }
  }
}

function scheduleFlush(state: LeadsStreamState): void {
  if (state.debounceTimer) {
    clearTimeout(state.debounceTimer)
  }

  state.debounceTimer = setTimeout(() => {
    state.debounceTimer = null
    flushPending(state)
  }, DEBOUNCE_MS)
}

function noteLeadChange(state: LeadsStreamState, id: string): void {
  state.pendingLeadIds.add(id)
  scheduleFlush(state)
}

function noteLeadInsert(
  state: LeadsStreamState,
  id: string,
  campaignId: string,
): void {
  state.pendingInserts.push({ id, campaignId })
  scheduleFlush(state)
}

function forwardEvent(state: LeadsStreamState, event: PipelineEventRow): void {
  for (const sub of state.subscribers) {
    if (sub.signal.aborted) continue
    try {
      sub.enqueueEvent(event)
    } catch {
      state.subscribers.delete(sub)
    }
  }
}

function removeChannel(state: LeadsStreamState): void {
  if (state.channelReconnectTimer) {
    clearTimeout(state.channelReconnectTimer)
    state.channelReconnectTimer = null
  }
  // Detach BEFORE removing. `supabase.removeChannel()` dispatches CLOSED to the
  // subscribe callback, and that handler calls back in here — so clearing the
  // reference afterwards means the re-entrant call still sees a live channel and
  // recurses until the stack blows.
  //
  // The re-entry arrives through the promise `removeChannel()` returns, not on
  // this stack, which is why it presents as a burst of unhandled `RangeError`s
  // rather than a throw at the call site — and why the outer `state.channel =
  // null` appeared to have run. `verify:leads` asserts it on an
  // `unhandledRejection` listener for exactly that reason; a try/catch sees
  // nothing. Same shape, same fix in `lib/dashboard-stream.ts`.
  const channel = state.channel
  if (channel) {
    state.channel = null
    void getSupabaseAdmin().removeChannel(channel)
  }
}

function scheduleChannelReconnect(state: LeadsStreamState): void {
  if (state.channelReconnectTimer || subscriberCount(state) === 0) return

  if (state.channelBackoffAttempt >= MAX_CHANNEL_BACKOFF_ATTEMPTS) {
    notifyChannelError(
      state,
      "Realtime channel unavailable — falling back to polling.",
    )
    return
  }

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

function ensureChannel(state: LeadsStreamState): void {
  if (state.channel || subscriberCount(state) === 0) return

  const supabase = getSupabaseAdmin()
  const channel = supabase
    .channel("leads-realtime")
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "campaign_leads" },
      (payload) => {
        const row = payload.new as { id?: string; campaign_id?: string } | null
        if (row?.id && row.campaign_id) {
          noteLeadInsert(state, row.id, row.campaign_id)
        }
      },
    )
    .on(
      "postgres_changes",
      { event: "UPDATE", schema: "public", table: "campaign_leads" },
      (payload) => {
        const id = (payload.new as { id?: string } | null)?.id
        if (id) noteLeadChange(state, id)
      },
    )
    .on(
      "postgres_changes",
      { event: "DELETE", schema: "public", table: "campaign_leads" },
      (payload) => {
        const id = (payload.old as { id?: string } | null)?.id
        if (id) noteLeadChange(state, id)
      },
    )
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "pipeline_events" },
      (payload) => {
        forwardEvent(state, payload.new as PipelineEventRow)
      },
    )
    .subscribe((status) => {
      if (status === "SUBSCRIBED") {
        state.channelBackoffAttempt = 0
        flushPending(state)
        emitResync(state)
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

function teardownChannelIfIdle(state: LeadsStreamState): void {
  if (subscriberCount(state) > 0) return

  if (state.debounceTimer) {
    clearTimeout(state.debounceTimer)
    state.debounceTimer = null
  }
  state.pendingLeadIds.clear()
  state.pendingInserts = []
  removeChannel(state)
  state.channelBackoffAttempt = 0
}

export function subscribeLeadsStream(
  subscriber: LeadsStreamSubscriber,
): () => void {
  const state = getState()
  state.subscribers.add(subscriber)

  ensureChannel(state)

  return () => {
    state.subscribers.delete(subscriber)
    teardownChannelIfIdle(state)
  }
}

export { encodeSseComment, encodeSseEvent } from "@/lib/dashboard-stream"
export { leadStreamScopeKey, type LeadStreamScope }
