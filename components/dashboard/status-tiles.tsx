import Link from "next/link"

import type { LeadStatusCounts } from "@/lib/campaign-types"
import {
  leadsFilterHref,
  STATUS_TILE_LABELS,
  STATUS_TILE_ORDER,
} from "@/lib/dashboard-types"
import { cn } from "@/lib/utils"

type StatusTilesProps = {
  tiles: LeadStatusCounts
  dryRunCount: number
  campaignId: string | null
  includeArchived: boolean
}

export function StatusTiles({
  tiles,
  dryRunCount,
  campaignId,
  includeArchived,
}: StatusTilesProps) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4 2xl:grid-cols-7">
      {STATUS_TILE_ORDER.map((status) => {
        const count = tiles[status]
        const href = leadsFilterHref({
          campaignId,
          status,
          includeArchived,
        })

        return (
          <Link
            key={status}
            href={href}
            className={cn(
              "rounded-2xl border border-border bg-card p-4 transition-colors hover:bg-muted/40",
            )}
          >
            <div className="text-sm text-muted-foreground">
              {STATUS_TILE_LABELS[status]}
            </div>
            <div className="mt-2 text-2xl font-semibold tabular-nums">{count}</div>
            {status === "deployed" && dryRunCount > 0 ? (
              <div className="mt-1 text-xs text-muted-foreground">
                {dryRunCount} dry-run
              </div>
            ) : null}
          </Link>
        )
      })}
    </div>
  )
}
