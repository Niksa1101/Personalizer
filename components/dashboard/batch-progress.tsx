import type { DashboardBatch } from "@/lib/dashboard-types"
import { cn } from "@/lib/utils"

type BatchProgressProps = {
  batches: DashboardBatch[]
  batchesTotal: number
  showCampaignName: boolean
}

function batchLabel(batch: DashboardBatch, showCampaignName: boolean): string {
  const base = `Batch ${batch.ordinal}`
  return showCampaignName ? `${base} · ${batch.campaign_name}` : base
}

export function BatchProgress({
  batches,
  batchesTotal,
  showCampaignName,
}: BatchProgressProps) {
  if (batches.length === 0) return null

  const hiddenCount = Math.max(0, batchesTotal - batches.length)

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-medium">Active batches</h3>
        <p className="text-sm text-muted-foreground">
          Progress excludes skipped leads from the bar denominator.
        </p>
      </div>

      <div className="space-y-4">
        {batches.map((batch) => {
          const completed = batch.done + batch.failed
          const denominator = Math.max(batch.total, 1)
          const donePct = (batch.done / denominator) * 100
          const failedPct = (batch.failed / denominator) * 100
          const pausedPct = (batch.paused / denominator) * 100
          const remainingPct = (batch.remaining / denominator) * 100
          const etaSuffix =
            batch.etaSeconds != null ? `, ${batch.etaLabel} remaining` : null

          return (
            <div key={batch.batch_id} className="space-y-2 rounded-2xl border border-border p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div className="font-medium">{batchLabel(batch, showCampaignName)}</div>
                <div className="text-sm text-muted-foreground">
                  {completed} of {batch.total} complete
                  {etaSuffix}
                  {batch.etaSeconds == null && batch.etaLabel
                    ? `, ${batch.etaLabel}`
                    : null}
                </div>
              </div>

              <div className="flex h-3 overflow-hidden rounded-full bg-muted">
                {donePct > 0 ? (
                  <div
                    className={cn("bg-primary")}
                    style={{ width: `${donePct}%` }}
                    title={`Done: ${batch.done}`}
                  />
                ) : null}
                {failedPct > 0 ? (
                  <div
                    className="bg-destructive"
                    style={{ width: `${failedPct}%` }}
                    title={`Failed: ${batch.failed}`}
                  />
                ) : null}
                {pausedPct > 0 ? (
                  <div
                    className="bg-secondary"
                    style={{ width: `${pausedPct}%` }}
                    title={`Paused: ${batch.paused}`}
                  />
                ) : null}
                {remainingPct > 0 ? (
                  <div
                    className="bg-muted-foreground/30"
                    style={{ width: `${remainingPct}%` }}
                    title={`Remaining: ${batch.remaining}`}
                  />
                ) : null}
              </div>

              {batch.skipped > 0 || batch.paused > 0 ? (
                <div className="text-xs text-muted-foreground">
                  {batch.skipped > 0 ? `${batch.skipped} skipped` : null}
                  {batch.skipped > 0 && batch.paused > 0 ? " · " : null}
                  {batch.paused > 0 ? `${batch.paused} paused` : null}
                </div>
              ) : null}
            </div>
          )
        })}
      </div>

      {hiddenCount > 0 ? (
        <p className="text-sm text-muted-foreground">+{hiddenCount} more</p>
      ) : null}
    </div>
  )
}
