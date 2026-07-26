"use client"

import { useEffect, useState } from "react"
import Link from "next/link"

import { Badge } from "@/components/ui/badge"
import type { DashboardProcessingRow } from "@/lib/dashboard-types"
import {
  formatElapsed,
  leadsFilterHref,
  STEP_LABELS,
} from "@/lib/dashboard-types"

type ProcessingListProps = {
  rows: DashboardProcessingRow[]
  processingTotal: number
  campaignId: string | null
  includeArchived: boolean
}

function leadLabel(row: DashboardProcessingRow): string {
  const name = row.name?.trim()
  const company = row.company?.trim()
  if (name && company) return `${name} · ${company}`
  return name || company || "Unknown lead"
}

function elapsedSeconds(stepStartedAt: string | null, nowMs: number): number | null {
  if (!stepStartedAt) return null
  const startedMs = Date.parse(stepStartedAt)
  if (Number.isNaN(startedMs)) return null
  return Math.max(0, (nowMs - startedMs) / 1000)
}

export function ProcessingList({
  rows,
  processingTotal,
  campaignId,
  includeArchived,
}: ProcessingListProps) {
  const [nowMs, setNowMs] = useState(() => Date.now())

  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])

  if (processingTotal === 0) return null

  const hiddenCount = Math.max(0, processingTotal - rows.length)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h3 className="text-sm font-medium">Currently processing</h3>
          <p className="text-sm text-muted-foreground">
            Sorted by longest elapsed step time.
          </p>
        </div>
        {hiddenCount > 0 ? (
          <Link
            href={leadsFilterHref({
              campaignId,
              status: "processing",
              includeArchived,
            })}
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            +{hiddenCount} more
          </Link>
        ) : null}
      </div>

      <div className="divide-y divide-border rounded-2xl border border-border">
        {rows.map((row) => {
          const elapsed = elapsedSeconds(row.step_started_at, nowMs)
          const stalled =
            row.stalledThresholdMs != null &&
            row.step_started_at != null &&
            nowMs - Date.parse(row.step_started_at) > row.stalledThresholdMs

          return (
            <div
              key={row.id}
              className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
            >
              <div className="min-w-0 space-y-1">
                <div className="truncate font-medium">{leadLabel(row)}</div>
                <div className="text-sm text-muted-foreground">
                  {STEP_LABELS[row.current_step]}
                  {row.attempt_count > 1 ? ` · attempt ${row.attempt_count}` : ""}
                </div>
              </div>

              <div className="flex items-center gap-2">
                <span className="text-sm tabular-nums text-muted-foreground">
                  {elapsed == null ? "starting…" : formatElapsed(elapsed)}
                </span>
                {stalled ? <Badge variant="destructive">Stalled</Badge> : null}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
