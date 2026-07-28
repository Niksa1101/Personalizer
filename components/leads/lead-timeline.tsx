"use client"

import { formatDateTime } from "@/lib/format"
import type { Database } from "@/lib/database.types"

type PipelineEventRow = Database["public"]["Tables"]["pipeline_events"]["Row"]

type LeadTimelineProps = {
  events: PipelineEventRow[]
  attemptCount: number
}

export function LeadTimeline({ events, attemptCount }: LeadTimelineProps) {
  return (
    <section className="space-y-3">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-medium">Timeline</h3>
        <span className="text-xs text-muted-foreground">
          {attemptCount} attempt{attemptCount === 1 ? "" : "s"} on current step
        </span>
      </div>
      <ol className="space-y-2 text-sm">
        {events.map((event) => (
          <li
            key={event.id}
            className="rounded-md border px-3 py-2"
          >
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="font-medium capitalize">
                {event.kind.replace(/_/g, " ")}
                {event.step ? ` · ${event.step}` : ""}
              </span>
              <time className="text-xs text-muted-foreground">
                {formatDateTime(event.created_at)}
              </time>
            </div>
            <p className="mt-1 text-muted-foreground">{event.message}</p>
          </li>
        ))}
      </ol>
    </section>
  )
}
