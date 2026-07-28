import { LOG_LEVELS, type LogLevel } from "@/lib/log-filters"
import { quotePostgrestValue } from "@/lib/lead-filters"
import type { LogCursor } from "@/lib/log-filters"

export function buildLogCursorFilter(cursor: LogCursor): string {
  const createdAt = quotePostgrestValue(cursor.createdAt)
  return `created_at.lt.${createdAt},and(created_at.eq.${createdAt},id.lt.${cursor.id})`
}

export function shouldFilterLevels(
  levels: LogLevel[],
): "all" | "some" | "empty" {
  if (levels.length === 0) return "empty"
  if (levels.length >= LOG_LEVELS.length) return "all"
  return "some"
}
