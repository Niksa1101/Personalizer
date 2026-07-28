"use client"

import Link from "next/link"

import {
  ACTION_CONTROLS,
  type DrawerActionContext,
} from "@/components/leads/drawer-actions"
import { errorCopyFor } from "@/lib/error-copy"
import type { DrawerAction } from "@/lib/error-copy"
import type { ErrorCode } from "@/lib/pipeline-types"
import type { LeadStatus } from "@/lib/campaign-types"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"

type LeadErrorBlockProps = {
  errorCode: ErrorCode | null
  errorDetail: string | null
  attemptCount: number
  status: LeadStatus
  campaignLeadId: string
  websiteUrl: string | null
  pausedReason?: { sentence: string; createdAt: string } | null
  pinned?: boolean
  onDeleteDuplicate?: () => void
}

export function LeadErrorBlock({
  errorCode,
  errorDetail,
  attemptCount,
  status,
  campaignLeadId,
  websiteUrl,
  pausedReason,
  pinned,
  onDeleteDuplicate,
}: LeadErrorBlockProps) {
  if (!errorCode && !pausedReason) return null

  const ctx: DrawerActionContext = {
    campaignLeadId,
    status,
    websiteUrl,
    onDeleteDuplicate,
  }

  if (errorCode) {
    const copy = errorCopyFor(errorCode)
    return (
      <Alert variant={status === "failed" || pinned ? "destructive" : "default"}>
        <AlertTitle>{copy.sentence}</AlertTitle>
        <AlertDescription className="space-y-2">
          {errorDetail ? <p>{errorDetail}</p> : null}
          <p className="text-xs opacity-80">
            {copy.bucket.replace("_", " ")} · {attemptCount} attempt
            {attemptCount === 1 ? "" : "s"} on this step
          </p>
          <div>{ACTION_CONTROLS[copy.action.id](ctx)}</div>
        </AlertDescription>
      </Alert>
    )
  }

  const action: DrawerAction = { id: "resume" }

  return (
    <Alert variant="default">
      <AlertTitle>{pausedReason!.sentence}</AlertTitle>
      <AlertDescription className="space-y-2">
        <p className="text-xs opacity-80">
          Paused · {attemptCount} attempt{attemptCount === 1 ? "" : "s"} on this step
        </p>
        <div>{ACTION_CONTROLS[action.id](ctx)}</div>
      </AlertDescription>
    </Alert>
  )
}

export function DomainConflictHint({
  conflictRef,
  domain,
}: {
  conflictRef?: string
  domain?: string
}) {
  if (!conflictRef) return null
  return (
    <p className="text-xs text-muted-foreground">
      Conflicts with{" "}
      <Link href={`/leads?q=${encodeURIComponent(conflictRef)}`} className="underline">
        {conflictRef}
      </Link>
      {domain ? ` (${domain})` : ""}.
    </p>
  )
}
