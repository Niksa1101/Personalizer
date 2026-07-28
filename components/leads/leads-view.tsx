"use client"

import { useRouter } from "next/navigation"
import { Suspense, useCallback, useEffect, useMemo, useState } from "react"
import { toast } from "sonner"

import {
  bulkDeleteAction,
  bulkRetryAction,
  loadLeadDetailAction,
} from "@/app/(app)/leads/actions"
import { ConnectivityIndicator } from "@/components/connectivity-indicator"
import { BulkActionBar } from "@/components/leads/bulk-action-bar"
import { LeadDrawer } from "@/components/leads/lead-drawer"
import { LeadFiltersBar } from "@/components/leads/lead-filters-bar"
import { LeadPagination } from "@/components/leads/lead-pagination"
import { LeadsTable } from "@/components/leads/leads-table"
import { useLeadsStream } from "@/components/leads/use-leads-stream"
import { EmptyState } from "@/components/empty-state"
import { Button } from "@/components/ui/button"
import type { CampaignOption, LeadListResult } from "@/lib/leads"
import {
  leadsPageHref,
  type LeadFilters,
  type LeadStreamScope,
} from "@/lib/lead-filters"
import type { Database } from "@/lib/database.types"
import { Users } from "lucide-react"
import Link from "next/link"

type PipelineEventRow = Database["public"]["Tables"]["pipeline_events"]["Row"]

type LeadsViewProps = {
  initialResult: LeadListResult
  campaigns: CampaignOption[]
  filters: LeadFilters
  batches: Array<{ id: string; label: string }>
}

export function LeadsView({
  initialResult,
  campaigns,
  filters,
  batches,
}: LeadsViewProps) {
  const router = useRouter()
  const [rows, setRows] = useState(initialResult.rows)
  const [seededFrom, setSeededFrom] = useState(initialResult)
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [openLeadId, setOpenLeadId] = useState<string | null>(
    filters.leadId ?? null,
  )
  const [drawerEvents, setDrawerEvents] = useState<PipelineEventRow[]>([])

  const scope: LeadStreamScope = useMemo(
    () => ({
      campaignId: filters.campaignId ?? null,
      includeArchived: filters.includeArchived,
    }),
    [filters.campaignId, filters.includeArchived],
  )

  const onFullRefetch = useCallback(() => {
    router.refresh()
  }, [router])

  const onDrawerEvent = useCallback((event: PipelineEventRow) => {
    setDrawerEvents((prev) => [event, ...prev])
  }, [])

  const stream = useLeadsStream({
    scope,
    filters,
    rows,
    onRowsPatch: setRows,
    onFullRefetch,
    openLeadId,
    onDrawerEvent,
  })

  if (seededFrom !== initialResult) {
    setSeededFrom(initialResult)
    setRows(initialResult.rows)
    stream.clearIndicators()
  }

  const openDrawer = useCallback(
    (leadId: string) => {
      setOpenLeadId(leadId)
      setDrawerEvents([])
      const params = new URLSearchParams(window.location.search)
      params.set("lead", leadId)
      window.history.pushState(null, "", `/leads?${params.toString()}`)
    },
    [],
  )

  const closeDrawer = useCallback(() => {
    setOpenLeadId(null)
    setDrawerEvents([])
    const params = new URLSearchParams(window.location.search)
    params.delete("lead")
    const query = params.toString()
    window.history.pushState(null, "", query ? `/leads?${query}` : "/leads")
  }, [])

  useEffect(() => {
    const onPopState = () => {
      const params = new URLSearchParams(window.location.search)
      setOpenLeadId(params.get("lead"))
    }
    window.addEventListener("popstate", onPopState)
    return () => window.removeEventListener("popstate", onPopState)
  }, [])

  const navigateDrawer = useCallback(
    (direction: -1 | 1) => {
      if (!openLeadId) return
      const index = rows.findIndex((row) => row.id === openLeadId)
      if (index < 0) return
      const next = rows[index + direction]
      if (next) openDrawer(next.id)
    },
    [openLeadId, openDrawer, rows],
  )

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable)
      ) {
        return
      }
      if (event.key === "j") {
        event.preventDefault()
        navigateDrawer(1)
      }
      if (event.key === "k") {
        event.preventDefault()
        navigateDrawer(-1)
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [navigateDrawer])

  async function handleBulkRetry() {
    const ids = [...selected]
    const { outcomes } = await bulkRetryAction(ids)
    const skipped = outcomes.filter((o) => o.outcome === "skipped")
    const failed = outcomes.filter((o) => o.outcome === "failed")
    if (failed.length > 0) {
      toast.error(`${failed.length} lead(s) failed to retry`)
    } else if (skipped.length > 0) {
      toast.message(`${skipped.length} skipped`, {
        description: skipped.map((o) => `${o.ref}: ${o.reason}`).join("; "),
      })
    } else {
      toast.success(`Retried ${outcomes.length} lead(s)`)
    }
    setSelected(new Set())
    router.refresh()
  }

  async function handleBulkDelete(retain: boolean) {
    const ids = [...selected]
    const { outcomes } = await bulkDeleteAction(ids, retain)
    const failed = outcomes.filter((o) => o.outcome === "failed")
    if (failed.length > 0) {
      toast.error(`${failed.length} lead(s) failed to remove`)
    } else {
      toast.success(`Removed ${outcomes.length} lead(s) from campaign`)
    }
    setSelected(new Set())
    router.refresh()
  }

  const hasActiveFilters = Boolean(
    filters.campaignId ||
      filters.status ||
      filters.bucket ||
      filters.batchId ||
      filters.search ||
      filters.includeArchived,
  )

  const showEmpty = initialResult.total === 0 && !hasActiveFilters

  return (
    <div className="flex flex-1 flex-col gap-4 p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold tracking-tight">Leads</h2>
          <p className="text-sm text-muted-foreground">
            {initialResult.total.toLocaleString()} lead
            {initialResult.total === 1 ? "" : "s"}
            {hasActiveFilters ? " matching filters" : ""}
          </p>
        </div>
        <ConnectivityIndicator
          state={stream.connectivity}
          lastUpdatedLabel={stream.lastUpdatedLabel}
        />
      </div>

      <Suspense fallback={null}>
        <LeadFiltersBar
          filters={filters}
          campaigns={campaigns}
          batches={batches}
        />
      </Suspense>

      {stream.newLeadCount > 0 ? (
        <Button
          variant="outline"
          size="sm"
          className="self-start"
          onClick={stream.handleFullRefetch}
        >
          {stream.newLeadCount} new lead
          {stream.newLeadCount === 1 ? "" : "s"} — refresh
        </Button>
      ) : null}

      {showEmpty ? (
        <div className="flex flex-1 flex-col items-center justify-center py-12">
          <EmptyState
            icon={<Users />}
            title="No leads yet"
            description="Leads appear here after you import a CSV and assign them to a campaign."
            action={<Button render={<Link href="/import" />}>Import CSV</Button>}
          />
        </div>
      ) : (
        <>
          <BulkActionBar
            count={selected.size}
            onRetry={handleBulkRetry}
            onDelete={handleBulkDelete}
            onClear={() => setSelected(new Set())}
          />

          <LeadsTable
            rows={rows}
            staleIds={stream.staleIds}
            selected={selected}
            onSelectedChange={setSelected}
            onRowClick={openDrawer}
            onStaleClick={(id) => {
              void stream.handleFullRefetch()
              stream.clearIndicators()
              openDrawer(id)
            }}
            sort={filters.sort}
            order={filters.order}
            pageHref={(overrides) => leadsPageHref(filters, overrides)}
          />

          <LeadPagination
            page={initialResult.page}
            pageCount={initialResult.pageCount}
            total={initialResult.total}
            hrefForPage={(page) => leadsPageHref(filters, { page })}
          />
        </>
      )}

      <LeadDrawer
        leadId={openLeadId}
        pageLeadIds={rows.map((row) => row.id)}
        extraEvents={drawerEvents}
        onClose={closeDrawer}
        onNavigate={navigateDrawer}
        loadDetail={loadLeadDetailAction}
      />
    </div>
  )
}
