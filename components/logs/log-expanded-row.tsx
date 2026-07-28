"use client"

import Link from "next/link"
import { useState } from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import type { LogRow } from "@/lib/log-filters"

const PREVIEW_LINES = 10

export function LogExpandedRow({ row }: { row: LogRow }) {
  const [showAll, setShowAll] = useState(false)
  const messageLines = row.message.split("\n")
  const preview = messageLines.slice(0, PREVIEW_LINES).join("\n")
  const hasMore = messageLines.length > PREVIEW_LINES

  const meta =
    row.meta && typeof row.meta === "object"
      ? JSON.stringify(row.meta, null, 2)
      : null

  return (
    <div className="space-y-3 text-sm">
      <div>
        <p className="mb-1 font-medium">Message</p>
        <pre className="max-h-48 overflow-auto rounded-md bg-background p-3 font-mono text-xs whitespace-pre-wrap">
          {showAll || !hasMore ? row.message : preview}
        </pre>
        {hasMore && !showAll ? (
          <Button
            variant="link"
            size="sm"
            className="h-auto px-0"
            onClick={() => setShowAll(true)}
          >
            Show all ({messageLines.length} lines)
          </Button>
        ) : null}
        <Button
          variant="outline"
          size="sm"
          className="mt-2"
          onClick={async () => {
            await navigator.clipboard.writeText(row.message)
            toast.success("Copied message")
          }}
        >
          Copy message
        </Button>
      </div>

      {meta ? (
        <div>
          <p className="mb-1 font-medium">Meta</p>
          <pre className="max-h-48 overflow-auto rounded-md bg-background p-3 font-mono text-xs">
            {meta}
          </pre>
        </div>
      ) : null}

      <div className="flex flex-wrap gap-3 text-xs">
        {row.campaign_lead_id ? (
          <Link
            href={`/leads?lead=${row.campaign_lead_id}`}
            className="underline"
          >
            View lead
          </Link>
        ) : null}
        {row.job_run_id ? (
          <span className="text-muted-foreground">Job run: {row.job_run_id}</span>
        ) : null}
      </div>
    </div>
  )
}
