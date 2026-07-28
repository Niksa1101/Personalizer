"use server"

import { verifySession } from "@/lib/dal"
import { parseLogFilters, type LogsSearchParams } from "@/lib/log-filters"
import { countNewLogs } from "@/lib/logs"

export async function countNewLogsAction(
  since: string,
  searchParams: LogsSearchParams,
): Promise<number> {
  await verifySession()
  const filters = parseLogFilters(searchParams)
  return countNewLogs(since, filters)
}
