"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { Fragment, useEffect, useMemo, useState, useTransition } from "react"
import { ChevronRight } from "lucide-react"

import { countNewLogsAction } from "@/app/(app)/logs/actions"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { LogExpandedRow } from "@/components/logs/log-expanded-row"
import {
  describeInvalidLogParams,
  formatLogWindowLabel,
  LOG_LEVELS,
  LOG_SCOPES,
  logsPageHref,
  type LogFilters,
  type LogTimePreset,
} from "@/lib/log-filters"
import { resolveLogTimeWindow } from "@/lib/log-filters"
import type { LogListResult } from "@/lib/logs"

type LogsViewProps = {
  initialResult: LogListResult
  filters: LogFilters
  loadedAt: string
}

export function LogsView({ initialResult, filters, loadedAt }: LogsViewProps) {
  const router = useRouter()
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const [newCount, setNewCount] = useState(0)
  const [, startTransition] = useTransition()

  const openEnded = useMemo(
    () => resolveLogTimeWindow(filters).openEnded,
    [filters],
  )

  useEffect(() => {
    if (!openEnded) return

    const timer = setInterval(() => {
      void countNewLogsAction(loadedAt, serializeParams(filters)).then(setNewCount)
    }, 15_000)

    return () => clearInterval(timer)
  }, [filters, loadedAt, openEnded])

  const displayNewCount = openEnded ? newCount : 0

  const paramNotices = useMemo(
    () => describeInvalidLogParams(filters),
    [filters],
  )

  // A rejected level param leaves filters.levels holding every level so the
  // rest of the UI stays sane; the boxes must not claim those levels are on.
  const checkedLevels = filters.levelsAllInvalid ? [] : filters.levels

  function navigate(next: Partial<LogFilters>) {
    startTransition(() => {
      router.push(logsPageHref(filters, next))
    })
  }

  const windowLabel = formatLogWindowLabel(filters)

  return (
    <div className="flex flex-1 flex-col gap-4 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Logs</h1>
          <p className="text-sm text-muted-foreground">
            Pipeline output for {windowLabel}.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {openEnded && displayNewCount > 0 ? (
            <Badge variant="secondary">{displayNewCount} new since load</Badge>
          ) : null}
          <Button variant="outline" size="sm" onClick={() => router.refresh()}>
            Refresh
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap gap-3 rounded-xl border border-border p-4">
        <div className="space-y-2">
          <Label>Time range</Label>
          <Select
            value={filters.preset}
            onValueChange={(value) =>
              navigate({ preset: value as LogTimePreset, cursor: undefined })
            }
          >
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="1h">Last hour</SelectItem>
              <SelectItem value="24h">Last 24 hours</SelectItem>
              <SelectItem value="7d">Last 7 days</SelectItem>
              <SelectItem value="30d">Last 30 days</SelectItem>
              <SelectItem value="all">All time</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Label>Scope</Label>
          <Select
            value={filters.scope ?? "all"}
            onValueChange={(value) =>
              navigate({
                scope: value === "all" ? undefined : (value as typeof filters.scope),
                cursor: undefined,
              })
            }
          >
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All scopes</SelectItem>
              {LOG_SCOPES.map((scope) => (
                <SelectItem key={scope} value={scope}>
                  {scope}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Label htmlFor="log-lead">Lead ref</Label>
          <Input
            id="log-lead"
            defaultValue={filters.leadRef ?? ""}
            placeholder="LD-0042"
            className="w-36"
            onKeyDown={(event) => {
              if (event.key !== "Enter") return
              navigate({
                leadRef: event.currentTarget.value.trim() || undefined,
                cursor: undefined,
              })
            }}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="log-search">Search message</Label>
          <Input
            id="log-search"
            defaultValue={filters.search ?? ""}
            placeholder="ffmpeg, deploy, …"
            className="w-48"
            onKeyDown={(event) => {
              if (event.key !== "Enter") return
              navigate({
                search: event.currentTarget.value.trim() || undefined,
                cursor: undefined,
              })
            }}
          />
        </div>

        <div className="space-y-2">
          <Label>Levels</Label>
          <div className="flex flex-wrap gap-3">
            {LOG_LEVELS.map((level) => (
              <label key={level} className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={checkedLevels.includes(level)}
                  onCheckedChange={(checked) => {
                    const next = checked
                      ? [...checkedLevels, level]
                      : checkedLevels.filter((item) => item !== level)
                    navigate({
                      levels: next.length > 0 ? next : [...LOG_LEVELS],
                      cursor: undefined,
                    })
                  }}
                />
                {level}
              </label>
            ))}
          </div>
        </div>
      </div>

      {initialResult.unknownLeadRef ? (
        <p className="text-sm text-muted-foreground">{initialResult.leadRefMessage}</p>
      ) : null}

      {paramNotices.map((notice) => (
        <p key={notice.kind} className="text-sm text-muted-foreground">
          {notice.message}{" "}
          <Button
            variant="link"
            className="h-auto p-0 text-sm"
            onClick={() =>
              navigate(
                notice.kind === "levels"
                  ? { levels: [...LOG_LEVELS], cursor: undefined }
                  : { cursor: undefined },
              )
            }
          >
            {notice.actionLabel}
          </Button>
        </p>
      ))}

      {initialResult.rows.length === 0 &&
      !initialResult.unknownLeadRef &&
      paramNotices.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
          <p>No logs in {windowLabel}.</p>
          {filters.preset === "24h" ? (
            <Button
              variant="link"
              className="mt-2"
              onClick={() => navigate({ preset: "7d", cursor: undefined })}
            >
              Widen to last 7 days
            </Button>
          ) : filters.preset === "7d" ? (
            <Button
              variant="link"
              className="mt-2"
              onClick={() => navigate({ preset: "30d", cursor: undefined })}
            >
              Widen to last 30 days
            </Button>
          ) : null}
        </div>
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10" />
                <TableHead>Time</TableHead>
                <TableHead>Level</TableHead>
                <TableHead>Scope</TableHead>
                <TableHead>Message</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {initialResult.rows.map((row) => (
                <Fragment key={row.id}>
                  <TableRow
                    className="cursor-pointer"
                    role="button"
                    tabIndex={0}
                    aria-expanded={expandedId === row.id}
                    aria-controls={`log-detail-${row.id}`}
                    onClick={() =>
                      setExpandedId((current) => (current === row.id ? null : row.id))
                    }
                    onKeyDown={(event) => {
                      if (event.key !== "Enter" && event.key !== " ") return
                      event.preventDefault()
                      setExpandedId((current) => (current === row.id ? null : row.id))
                    }}
                  >
                    <TableCell className="w-10 p-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-8"
                        aria-expanded={expandedId === row.id}
                        aria-controls={`log-detail-${row.id}`}
                        aria-label={
                          expandedId === row.id ? "Collapse log detail" : "Expand log detail"
                        }
                        onClick={(event) => {
                          event.stopPropagation()
                          setExpandedId((current) =>
                            current === row.id ? null : row.id,
                          )
                        }}
                      >
                        <ChevronRight
                          className={
                            expandedId === row.id
                              ? "size-4 rotate-90 transition-transform"
                              : "size-4 transition-transform"
                          }
                        />
                      </Button>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                      {new Date(row.created_at).toLocaleString()}
                    </TableCell>
                    <TableCell>
                      <Badge variant={row.level === "error" ? "destructive" : "secondary"}>
                        {row.level}
                      </Badge>
                    </TableCell>
                    <TableCell>{row.scope}</TableCell>
                    <TableCell className="max-w-xl truncate">{row.message}</TableCell>
                  </TableRow>
                  {expandedId === row.id ? (
                    <TableRow>
                      <TableCell
                        id={`log-detail-${row.id}`}
                        colSpan={5}
                        className="bg-muted/30 p-4"
                      >
                        <LogExpandedRow row={row} />
                      </TableCell>
                    </TableRow>
                  ) : null}
                </Fragment>
              ))}
            </TableBody>
          </Table>

          {initialResult.nextCursor ? (
            <div className="flex justify-center">
              <Link
                href={logsPageHref(filters, { cursor: initialResult.nextCursor })}
                className="inline-flex h-8 items-center rounded-4xl border border-border px-3 text-sm hover:bg-muted"
              >
                Load 100 more
              </Link>
            </div>
          ) : null}
        </>
      )}
    </div>
  )
}

function serializeParams(filters: LogFilters): Record<string, string | undefined> {
  return {
    preset: filters.preset,
    from: filters.from,
    to: filters.to,
    level: filters.levels.join(","),
    scope: filters.scope,
    lead: filters.leadRef,
    q: filters.search,
    cursor: filters.cursor,
  }
}
