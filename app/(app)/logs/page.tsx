import { LogsView } from "@/components/logs/logs-view"
import {
  parseLogFilters,
  serializeLogFilters,
  type LogsSearchParams,
} from "@/lib/log-filters"
import { listLogs } from "@/lib/logs"

export const metadata = {
  title: "Logs",
}

type LogsPageProps = {
  searchParams: Promise<LogsSearchParams>
}

export default async function LogsPage({ searchParams }: LogsPageProps) {
  const params = await searchParams
  const filters = parseLogFilters(params)
  const result = await listLogs(filters)

  return (
    <LogsView
      key={serializeLogFilters(filters).toString()}
      initialResult={result}
      filters={filters}
      loadedAt={new Date().toISOString()}
    />
  )
}
