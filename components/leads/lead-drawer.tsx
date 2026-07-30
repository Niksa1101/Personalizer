"use client"

import { useEffect, useState } from "react"
import { ChevronDown, ChevronUp, Copy, ExternalLink } from "lucide-react"
import { toast } from "sonner"

import { deleteLeadAction, retryStepAction } from "@/app/(app)/leads/actions"
import { DeleteLeadDialog } from "@/components/leads/delete-lead-dialog"
import { LeadEditForm } from "@/components/leads/lead-edit-form"
import { LeadErrorBlock } from "@/components/leads/lead-error-block"
import { LeadMedia } from "@/components/leads/lead-media"
import { PromoteControls } from "@/components/leads/promote-controls"
import { LeadTimeline } from "@/components/leads/lead-timeline"
import { RetryControls } from "@/components/leads/retry-controls"
import { UnpublishDialog } from "@/components/leads/unpublish-dialog"
import {
  leadDisplayName,
  statusLabel,
} from "@/components/leads/lead-labels"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import type { LeadDetail } from "@/lib/leads"
import type { Database } from "@/lib/database.types"
import { formatDateTime } from "@/lib/format"

type PipelineEventRow = Database["public"]["Tables"]["pipeline_events"]["Row"]

type LeadDrawerProps = {
  leadId: string | null
  pageLeadIds: string[]
  extraEvents: PipelineEventRow[]
  onClose: () => void
  onNavigate: (direction: -1 | 1) => void
  loadDetail: (id: string) => Promise<LeadDetail | null>
}

export function LeadDrawer({
  leadId,
  pageLeadIds,
  extraEvents,
  onClose,
  onNavigate,
  loadDetail,
}: LeadDrawerProps) {
  const [detail, setDetail] = useState<LeadDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [unpublishOpen, setUnpublishOpen] = useState(false)

  useEffect(() => {
    if (!leadId) return
    let cancelled = false
    // Fetch-on-open is intentional; async setState in .then is the external sync.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loading gate before fetch
    setLoading(true)
    void loadDetail(leadId)
      .then((next) => {
        if (!cancelled) setDetail(next)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [leadId, loadDetail])

  const index = leadId ? pageLeadIds.indexOf(leadId) : -1
  const events = detail
    ? [...extraEvents, ...detail.events].filter(
        (event, idx, all) => all.findIndex((e) => e.id === event.id) === idx,
      )
    : extraEvents

  const landingLive =
    detail?.netlify_url &&
    detail.landing_pages?.deploy_status !== "removed" &&
    !detail.deployed_dry_run

  return (
    <>
      <Sheet open={leadId != null} onOpenChange={(open) => !open && onClose()}>
        <SheetContent side="right" className="w-full sm:max-w-[640px] overflow-y-auto">
          {detail ? (
            <>
              <SheetHeader className="space-y-2 pb-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <SheetTitle className="text-left">
                    {leadDisplayName(detail.leads)}{" "}
                    <span className="text-muted-foreground">
                      ({detail.leads.ref})
                    </span>
                  </SheetTitle>
                  <Badge>{statusLabel(detail.status)}</Badge>
                </div>
                <p className="text-sm text-muted-foreground">
                  {detail.campaigns.name} · updated{" "}
                  {formatDateTime(detail.updated_at)}
                </p>
                {detail.promoted_at ? (
                  <p className="text-xs text-muted-foreground">
                    {detail.status === "ready" ? "Approved" : "Previously approved"}{" "}
                    (promoted {formatDateTime(detail.promoted_at)})
                  </p>
                ) : null}
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={index <= 0}
                    onClick={() => onNavigate(-1)}
                  >
                    <ChevronUp className="size-4" />
                    Previous
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={index < 0 || index >= pageLeadIds.length - 1}
                    onClick={() => onNavigate(1)}
                  >
                    Next
                    <ChevronDown className="size-4" />
                  </Button>
                </div>
              </SheetHeader>

              <div className="space-y-6 pb-8">
                {detail.error_code || detail.pausedReason ? (
                  <LeadErrorBlock
                    errorCode={detail.error_code}
                    errorDetail={detail.error_detail}
                    attemptCount={detail.attempt_count}
                    status={detail.status}
                    campaignLeadId={detail.id}
                    websiteUrl={detail.leads.website_url}
                    pausedReason={detail.pausedReason}
                    pinned={detail.status === "failed"}
                    onDeleteDuplicate={onClose}
                  />
                ) : null}

                <section className="space-y-2">
                  <h3 className="text-sm font-medium">Landing URL</h3>
                  {detail.deployed_dry_run && !detail.netlify_url ? (
                    <Badge variant="secondary">Dry run — no live URL</Badge>
                  ) : detail.landing_pages?.deploy_status === "removed" ? (
                    <p className="text-sm line-through text-muted-foreground">
                      {detail.netlify_url ?? detail.landing_pages.path} (unpublished)
                    </p>
                  ) : detail.netlify_url ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <a
                        href={detail.netlify_url}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
                      >
                        {detail.netlify_url}
                        <ExternalLink className="size-3" />
                      </a>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={async () => {
                          await navigator.clipboard.writeText(detail.netlify_url!)
                          toast.success("Copied URL")
                        }}
                      >
                        <Copy className="size-4" />
                        Copy
                      </Button>
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">Not deployed yet</p>
                  )}
                </section>

                <section className="space-y-2">
                  <h3 className="text-sm font-medium">Approval</h3>
                  <PromoteControls
                    detail={detail}
                    disabled={loading}
                    onChanged={() => {
                      if (!leadId) return
                      setLoading(true)
                      void loadDetail(leadId)
                        .then((next) => setDetail(next))
                        .finally(() => setLoading(false))
                    }}
                  />
                </section>

                <section className="space-y-2">
                  <h3 className="text-sm font-medium">Per-step retry</h3>
                  <RetryControls
                    campaignLeadId={detail.id}
                    status={detail.status}
                    disabled={loading}
                  />
                </section>

                <LeadMedia
                  detail={detail}
                  campaignLeadId={detail.id}
                  status={detail.status}
                />

                <section className="space-y-2">
                  <h3 className="text-sm font-medium">Edit lead</h3>
                  <LeadEditForm
                    detail={detail}
                    onSaved={() => {
                      if (!leadId) return
                      setLoading(true)
                      void loadDetail(leadId)
                        .then((next) => setDetail(next))
                        .finally(() => setLoading(false))
                    }}
                  />
                </section>

                <LeadTimeline events={events} attemptCount={detail.attempt_count} />

                <section className="flex flex-wrap gap-2 border-t pt-4">
                  {landingLive || detail.landing_pages?.deploy_status === "live" ? (
                    <Button
                      variant="outline"
                      onClick={() => setUnpublishOpen(true)}
                    >
                      Unpublish page
                    </Button>
                  ) : detail.landing_pages?.deploy_status === "removed" ? (
                    <Button
                      variant="outline"
                      onClick={async () => {
                        const result = await retryStepAction(
                          detail.id,
                          "step",
                          "deploy",
                        )
                        if (result.error) toast.error(result.error)
                        else toast.success("Re-publish queued")
                      }}
                    >
                      Re-publish
                    </Button>
                  ) : null}
                  <Button
                    variant="destructive"
                    onClick={() => setDeleteOpen(true)}
                  >
                    Remove from campaign
                  </Button>
                </section>
              </div>
            </>
          ) : (
            <div className="py-12 text-center text-sm text-muted-foreground">
              {loading ? "Loading…" : "Lead not found"}
            </div>
          )}
        </SheetContent>
      </Sheet>

      {detail ? (
        <>
          <DeleteLeadDialog
            open={deleteOpen}
            onOpenChange={setDeleteOpen}
            title="Remove from campaign?"
            description="Removes this lead from the campaign. Videos and landing pages for this campaign go with it; the shared recording is kept."
            alreadyUnpublished={
              detail.landing_pages?.deploy_status === "removed"
            }
            onConfirm={async (retain) => {
              const result = await deleteLeadAction(detail.id, retain)
              if (result.error) toast.error(result.error)
              else {
                toast.success("Removed from campaign")
                onClose()
              }
            }}
          />
          <UnpublishDialog
            campaignLeadId={detail.id}
            open={unpublishOpen}
            onOpenChange={setUnpublishOpen}
            isReady={detail.status === "ready"}
            onDone={() => {
              if (!leadId) return
              void loadDetail(leadId).then(setDetail)
            }}
          />
        </>
      ) : null}
    </>
  )
}
