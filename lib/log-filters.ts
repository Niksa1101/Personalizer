import type { Database } from "@/lib/database.types"
import { isIsoTimestamp, parseIsoDateOrNull } from "@/lib/iso-time"

export const LOGS_PAGE_SIZE = 100

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const
export type LogLevel = (typeof LOG_LEVELS)[number]

export const LOG_SCOPES = [
  "importer",
  "recorder",
  "merger",
  "deployer",
  "web",
  "worker",
] as const
export type LogScope = (typeof LOG_SCOPES)[number]

export type LogTimePreset = "1h" | "24h" | "7d" | "30d" | "all"

export type LogFilters = {
  levels: LogLevel[]
  /** True when a level query param was present but contained no valid tokens. */
  levelsAllInvalid?: boolean
  scope?: LogScope
  leadRef?: string
  search?: string
  preset: LogTimePreset
  from?: string
  to?: string
  cursor?: string
  /** True when a cursor query param was present but failed validation. */
  cursorInvalid?: boolean
}

export type LogsSearchParams = Record<string, string | string[] | undefined>

function firstParam(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0]
  return value
}

function parseLevels(raw: string | undefined): {
  levels: LogLevel[]
  allInvalid: boolean
} {
  if (!raw) return { levels: [...LOG_LEVELS], allInvalid: false }
  const parts = raw.split(",").map((part) => part.trim())
  const filtered = parts.filter((part): part is LogLevel =>
    LOG_LEVELS.includes(part as LogLevel),
  )
  if (filtered.length === 0) {
    return { levels: [...LOG_LEVELS], allInvalid: true }
  }
  return { levels: filtered, allInvalid: false }
}

export function parseLogFilters(params: LogsSearchParams): LogFilters {
  const presetRaw = firstParam(params.preset) as LogTimePreset | undefined
  const preset =
    presetRaw && ["1h", "24h", "7d", "30d", "all"].includes(presetRaw)
      ? presetRaw
      : "24h"

  const scopeRaw = firstParam(params.scope)
  const scope = LOG_SCOPES.includes(scopeRaw as LogScope)
    ? (scopeRaw as LogScope)
    : undefined

  const levelRaw = firstParam(params.level)
  const { levels, allInvalid: levelsAllInvalid } = parseLevels(levelRaw)
  const cursorRaw = firstParam(params.cursor)

  return {
    levels,
    levelsAllInvalid,
    scope,
    leadRef: firstParam(params.lead)?.trim() || undefined,
    search: firstParam(params.q)?.trim() || undefined,
    preset,
    from: firstParam(params.from),
    to: firstParam(params.to),
    cursor: cursorRaw,
    cursorInvalid: Boolean(cursorRaw && !decodeLogCursor(cursorRaw)),
  }
}

export function serializeLogFilters(
  filters: LogFilters,
  overrides?: Partial<LogFilters>,
): URLSearchParams {
  const merged = { ...filters, ...overrides }
  const params = new URLSearchParams()

  if (merged.preset !== "24h") params.set("preset", merged.preset)
  if (merged.from) params.set("from", merged.from)
  if (merged.to) params.set("to", merged.to)
  if (merged.levels.length !== LOG_LEVELS.length) {
    params.set("level", merged.levels.join(","))
  }
  if (merged.scope) params.set("scope", merged.scope)
  if (merged.leadRef) params.set("lead", merged.leadRef)
  if (merged.search) params.set("q", merged.search)
  if (merged.cursor) params.set("cursor", merged.cursor)

  return params
}

export function logsPageHref(
  filters: LogFilters,
  overrides?: Partial<LogFilters>,
): string {
  const params = serializeLogFilters(filters, overrides)
  const query = params.toString()
  return query ? `/logs?${query}` : "/logs"
}

export function resolveLogTimeWindow(filters: LogFilters): {
  from: Date
  to: Date | null
  openEnded: boolean
} {
  if (filters.from) {
    const from =
      parseIsoDateOrNull(filters.from) ??
      resolveLogTimeWindow({ ...filters, from: undefined }).from
    const to = filters.to ? parseIsoDateOrNull(filters.to) : null
    const effectiveTo =
      filters.to && to == null
        ? resolveLogTimeWindow({ ...filters, from: undefined }).to
        : to
    return { from, to: effectiveTo, openEnded: effectiveTo == null }
  }

  const now = new Date()
  const to = filters.to ? new Date(filters.to) : now
  const openEnded = filters.to == null

  switch (filters.preset) {
    case "1h":
      return {
        from: new Date(now.getTime() - 60 * 60 * 1000),
        to,
        openEnded,
      }
    case "24h":
      return {
        from: new Date(now.getTime() - 24 * 60 * 60 * 1000),
        to,
        openEnded,
      }
    case "7d":
      return {
        from: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000),
        to,
        openEnded,
      }
    case "30d":
      return {
        from: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000),
        to,
        openEnded,
      }
    case "all":
      return {
        from: new Date(0),
        to,
        openEnded,
      }
    default:
      return {
        from: new Date(now.getTime() - 24 * 60 * 60 * 1000),
        to,
        openEnded,
      }
  }
}

export function formatLogWindowLabel(filters: LogFilters): string {
  if (filters.from) {
    const from =
      parseIsoDateOrNull(filters.from) ?? filters.from
    const to = filters.to
      ? (parseIsoDateOrNull(filters.to) ?? filters.to)
      : null
    return to ? `${from} – ${to}` : `since ${from}`
  }
  switch (filters.preset) {
    case "1h":
      return "the last hour"
    case "24h":
      return "the last 24 hours"
    case "7d":
      return "the last 7 days"
    case "30d":
      return "the last 30 days"
    case "all":
      return "all time"
    default:
      return "the last 24 hours"
  }
}

export type LogRow = Database["public"]["Tables"]["logs"]["Row"]

export type LogCursor = {
  createdAt: string
  id: number
}

export function encodeLogCursor(cursor: LogCursor): string {
  return `${cursor.createdAt}|${cursor.id}`
}

export function decodeLogCursor(raw: string | undefined): LogCursor | null {
  if (!raw) return null
  const parts = raw.split("|")
  if (parts.length !== 2) return null
  const [createdAt, idRaw] = parts
  const id = Number(idRaw)
  if (
    !createdAt ||
    !isIsoTimestamp(createdAt) ||
    !Number.isInteger(id) ||
    id < 0
  ) {
    return null
  }
  return { createdAt, id }
}
