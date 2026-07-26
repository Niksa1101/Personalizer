import Link from "next/link"

import type { DashboardCountsRaw } from "@/lib/dashboard-types"
import {
  BUCKET_ORDER,
  BUCKET_LABELS,
  leadsFilterHref,
} from "@/lib/dashboard-types"

type FailureBucketsProps = {
  buckets: DashboardCountsRaw["buckets"]
  campaignId: string | null
  includeArchived: boolean
}

export function FailureBuckets({
  buckets,
  campaignId,
  includeArchived,
}: FailureBucketsProps) {
  const byBucket = new Map(buckets.map((bucket) => [bucket.bucket, bucket]))
  const visible = BUCKET_ORDER.map((bucket) => byBucket.get(bucket)).filter(
    (bucket) => bucket && bucket.count > 0,
  )

  if (visible.length === 0) return null

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-medium">Failures by cause</h3>
        <p className="text-sm text-muted-foreground">
          Grouped by error bucket with a representative error code.
        </p>
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        {visible.map((bucket) =>
          bucket ? (
            <Link
              key={bucket.bucket}
              href={leadsFilterHref({
                campaignId,
                bucket: bucket.bucket,
                includeArchived,
              })}
              className="rounded-2xl border border-border bg-card p-4 transition-colors hover:bg-muted/40"
            >
              <div className="text-sm text-muted-foreground">
                {BUCKET_LABELS[bucket.bucket]}
              </div>
              <div className="mt-2 text-2xl font-semibold tabular-nums">
                {bucket.count}
              </div>
              {bucket.error_code ? (
                <div className="mt-1 font-mono text-xs text-muted-foreground">
                  {bucket.error_code}
                </div>
              ) : null}
            </Link>
          ) : null,
        )}
      </div>
    </div>
  )
}
