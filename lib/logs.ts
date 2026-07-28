import "server-only"

import {
  decodeLogCursor,
  encodeLogCursor,
  LOGS_PAGE_SIZE,
  type LogCursor,
  type LogFilters,
  type LogRow,
  resolveLogTimeWindow,
} from "@/lib/log-filters"
import { escapeIlikePattern } from "@/lib/lead-filters"
import { buildLogCursorFilter, shouldFilterLevels } from "@/lib/log-query"
import { getSupabaseAdmin } from "@/lib/supabase"

export type LogListResult = {
  rows: LogRow[]
  nextCursor: string | null
  unknownLeadRef?: boolean
  leadRefMessage?: string
}

export async function resolveLeadRefIds(ref: string): Promise<string[]> {
  const { data: lead, error: leadError } = await getSupabaseAdmin()
    .from("leads")
    .select("id")
    .eq("ref", ref)
    .maybeSingle()

  if (leadError) {
    throw new Error(`Failed to resolve lead ref: ${leadError.message}`)
  }
  if (!lead) return []

  const { data, error } = await getSupabaseAdmin()
    .from("campaign_leads")
    .select("id")
    .eq("lead_id", lead.id)

  if (error) {
    throw new Error(`Failed to resolve lead ref: ${error.message}`)
  }
  return (data ?? []).map((row) => row.id)
}

export async function listLogs(filters: LogFilters): Promise<LogListResult> {
  if (filters.levelsAllInvalid || filters.cursorInvalid) {
    return { rows: [], nextCursor: null }
  }

  const window = resolveLogTimeWindow(filters)

  let campaignLeadIds: string[] | null = null
  if (filters.leadRef) {
    campaignLeadIds = await resolveLeadRefIds(filters.leadRef)
    if (campaignLeadIds.length === 0) {
      return {
        rows: [],
        nextCursor: null,
        unknownLeadRef: true,
        leadRefMessage: `No lead found with ref ${filters.leadRef}`,
      }
    }
  }

  const levelFilter = shouldFilterLevels(filters.levels)
  if (levelFilter === "empty") {
    return { rows: [], nextCursor: null }
  }

  let query = getSupabaseAdmin()
    .from("logs")
    .select("*")
    .gte("created_at", window.from.toISOString())

  if (window.to) {
    query = query.lte("created_at", window.to.toISOString())
  }

  if (levelFilter === "some") {
    query = query.in("level", filters.levels)
  }

  if (filters.scope) {
    query = query.eq("scope", filters.scope)
  }

  if (campaignLeadIds) {
    query = query.in("campaign_lead_id", campaignLeadIds)
  }

  if (filters.search) {
    query = query.ilike("message", `%${escapeIlikePattern(filters.search)}%`)
  }

  const cursor = decodeLogCursor(filters.cursor)
  if (cursor) {
    query = query.or(buildLogCursorFilter(cursor))
  }

  query = query
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(LOGS_PAGE_SIZE + 1)

  const { data, error } = await query
  if (error) {
    throw new Error(`Failed to list logs: ${error.message}`)
  }

  const rows = data ?? []
  let nextCursor: string | null = null
  if (rows.length > LOGS_PAGE_SIZE) {
    const last = rows[LOGS_PAGE_SIZE - 1]!
    nextCursor = encodeLogCursor({
      createdAt: last.created_at,
      id: last.id,
    })
    rows.length = LOGS_PAGE_SIZE
  }

  return { rows, nextCursor }
}

export async function countNewLogs(
  since: string,
  filters: LogFilters,
): Promise<number> {
  if (filters.levelsAllInvalid || filters.cursorInvalid) return 0

  const window = resolveLogTimeWindow(filters)
  if (!window.openEnded) return 0

  const levelFilter = shouldFilterLevels(filters.levels)
  if (levelFilter === "empty") return 0

  let query = getSupabaseAdmin()
    .from("logs")
    .select("id", { count: "exact", head: true })
    .gt("created_at", since)
    .gte("created_at", window.from.toISOString())

  if (levelFilter === "some") {
    query = query.in("level", filters.levels)
  }
  if (filters.scope) query = query.eq("scope", filters.scope)
  if (filters.search) {
    query = query.ilike("message", `%${escapeIlikePattern(filters.search)}%`)
  }
  if (filters.leadRef) {
    const leadIds = await resolveLeadRefIds(filters.leadRef)
    if (leadIds.length === 0) return 0
    query = query.in("campaign_lead_id", leadIds)
  }

  const { count, error } = await query
  if (error) {
    throw new Error(`Failed to count new logs: ${error.message}`)
  }
  return count ?? 0
}

export type { LogCursor }
