"use client"

import Link from "next/link"
import type { ReactNode } from "react"
import { toast } from "sonner"

import {
  deleteLeadAction,
  requeueLeadAction,
  retryStepAction,
} from "@/app/(app)/leads/actions"
import { RetryStepButton } from "@/components/leads/retry-step-button"
import { Button } from "@/components/ui/button"
import type { DrawerActionId } from "@/lib/error-copy"
import type { DrawerActionContext } from "@/lib/drawer-action-controls"
import { canRetry } from "@/lib/lead-actions"
import { skippedRequeueBlockReason } from "@/lib/website-url"

export type { DrawerActionContext }

export const ACTION_CONTROLS: Record<
  DrawerActionId,
  (ctx: DrawerActionContext) => ReactNode
> = {
  // D52: eligibility comes from `canRetry` everywhere — an ad-hoc status check
  // here would disagree with the same button in RetryControls and with the
  // server guard inside retryCampaignLead.
  "retry-recording": (ctx) => (
    <RetryStepButton
      campaignLeadId={ctx.campaignLeadId}
      step="recording"
      disabled={!canRetry(ctx.status, "step", "recording")}
    />
  ),
  "retry-merge": (ctx) => (
    <RetryStepButton
      campaignLeadId={ctx.campaignLeadId}
      step="merge"
      disabled={!canRetry(ctx.status, "step", "merge")}
    />
  ),
  "retry-page": (ctx) => (
    <RetryStepButton
      campaignLeadId={ctx.campaignLeadId}
      step="page"
      disabled={!canRetry(ctx.status, "step", "page")}
    />
  ),
  "retry-deploy": (ctx) => (
    <RetryStepButton
      campaignLeadId={ctx.campaignLeadId}
      step="deploy"
      disabled={!canRetry(ctx.status, "step", "deploy")}
    />
  ),
  restart: (ctx) => (
    <Button
      size="sm"
      variant="outline"
      disabled={!canRetry(ctx.status, "restart")}
      onClick={async () => {
        const result = await retryStepAction(ctx.campaignLeadId, "restart")
        if (result.error) toast.error(result.error)
        else toast.success("Full restart queued")
      }}
    >
      Full restart
    </Button>
  ),
  resume: (ctx) => (
    <Button
      size="sm"
      variant="outline"
      disabled={!canRetry(ctx.status, "resume")}
      onClick={async () => {
        const result = await retryStepAction(ctx.campaignLeadId, "resume")
        if (result.error) toast.error(result.error)
        else toast.success("Resume queued")
      }}
    >
      Resume
    </Button>
  ),
  "requeue-recording": (ctx) => {
    const blockReason = skippedRequeueBlockReason(ctx.websiteUrl)
    return (
      <Button
        size="sm"
        variant="outline"
        disabled={blockReason != null}
        title={blockReason ?? undefined}
        onClick={async () => {
          const result = await requeueLeadAction(ctx.campaignLeadId)
          if (result.error) toast.error(result.error)
          else toast.success("Lead re-queued at recording")
        }}
      >
        Re-queue at recording
      </Button>
    )
  },
  "edit-fields": () => (
    <p className="text-xs text-muted-foreground">Edit the fields below.</p>
  ),
  "assign-intro": () => (
    <Button size="sm" variant="outline" render={<Link href="/intros" />}>
      Assign intro
    </Button>
  ),
  "remove-lead": (ctx) =>
    ctx.status === "skipped" ? (
      <Button
        size="sm"
        variant="outline"
        onClick={async () => {
          const result = await deleteLeadAction(ctx.campaignLeadId, false)
          if (result.error) toast.error(result.error)
          else {
            toast.success("Duplicate lead removed")
            ctx.onDeleteDuplicate?.()
          }
        }}
      >
        Delete this duplicate row
      </Button>
    ) : null,
  terminal: () => null,
}
