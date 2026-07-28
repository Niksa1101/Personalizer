"use client"

import Link from "next/link"
import { LayoutDashboard } from "lucide-react"
import { Suspense } from "react"

import { BatchProgress } from "@/components/dashboard/batch-progress"
import { CampaignScopeSelect } from "@/components/dashboard/campaign-scope-select"
import {
  ConnectivityIndicator,
  DashboardDimmer,
} from "@/components/connectivity-indicator"
import { FailureBuckets } from "@/components/dashboard/failure-buckets"
import { NeedsIntroBanner } from "@/components/dashboard/needs-intro-banner"
import { ProcessingList } from "@/components/dashboard/processing-list"
import { StatusTiles } from "@/components/dashboard/status-tiles"
import { useDashboardStream } from "@/components/dashboard/use-dashboard-stream"
import { EmptyState } from "@/components/empty-state"
import { Button } from "@/components/ui/button"
import type { CampaignListItem } from "@/lib/campaign-types"
import type { DashboardScope, DashboardSnapshot } from "@/lib/dashboard-types"

type DashboardViewProps = {
  initialSnapshot: DashboardSnapshot
  campaigns: CampaignListItem[]
  scope: DashboardScope
}

export function DashboardView({
  initialSnapshot,
  campaigns,
  scope,
}: DashboardViewProps) {
  const { snapshot, connectivity, lastUpdatedLabel, dimmed } =
    useDashboardStream(scope, initialSnapshot)

  const showCampaignName = scope.campaignId == null

  return (
    <div className="flex flex-1 flex-col gap-6 p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold tracking-tight">Dashboard</h2>
          <p className="text-sm text-muted-foreground">
            Live status across campaigns, batches, and failures.
          </p>
        </div>
        <ConnectivityIndicator
          state={connectivity}
          lastUpdatedLabel={lastUpdatedLabel}
        />
      </div>

      <Suspense fallback={null}>
        <CampaignScopeSelect
          campaigns={campaigns}
          campaignId={scope.campaignId}
          includeArchived={scope.includeArchived}
        />
      </Suspense>

      {snapshot.screenState === "empty" ? (
        <div className="flex flex-1 flex-col items-center justify-center py-12">
          <EmptyState
            icon={<LayoutDashboard />}
            title="Create your first campaign"
            description="Campaigns organize intro videos, merge settings, and landing pages for each batch of leads."
            action={
              <Button render={<Link href="/campaigns/new" />}>
                Create campaign
              </Button>
            }
          />
        </div>
      ) : (
        <DashboardDimmer dimmed={dimmed}>
          <div className="space-y-8">
            <NeedsIntroBanner campaigns={snapshot.pausedCampaigns} />

            <StatusTiles
              tiles={snapshot.tiles}
              dryRunCount={snapshot.dryRunCount}
              campaignId={scope.campaignId}
              includeArchived={scope.includeArchived}
            />

            {snapshot.screenState === "idle" ? (
              <div className="rounded-2xl border border-dashed border-border px-6 py-10 text-center">
                <h3 className="text-base font-medium">Nothing in the queue</h3>
                <p className="mt-2 text-sm text-muted-foreground">
                  Import a CSV to start processing, or check another campaign scope.
                </p>
              </div>
            ) : null}

            {snapshot.screenState === "all-done" ? (
              <div className="rounded-2xl border border-border bg-card px-6 py-10 text-center">
                <h3 className="text-base font-medium">All leads are terminal</h3>
                <p className="mt-2 text-sm text-muted-foreground">
                  Every lead in this scope has finished, failed, paused, or been
                  skipped.
                </p>
              </div>
            ) : null}

            <BatchProgress
              batches={snapshot.batches}
              batchesTotal={snapshot.batchesTotal}
              showCampaignName={showCampaignName}
            />

            <ProcessingList
              rows={snapshot.processing}
              processingTotal={snapshot.processingTotal}
              campaignId={scope.campaignId}
              includeArchived={scope.includeArchived}
            />

            <FailureBuckets
              buckets={snapshot.buckets}
              campaignId={scope.campaignId}
              includeArchived={scope.includeArchived}
            />
          </div>
        </DashboardDimmer>
      )}
    </div>
  )
}
