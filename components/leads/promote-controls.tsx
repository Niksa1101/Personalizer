"use client"

import { useState } from "react"
import { toast } from "sonner"

import {
  promoteLeadAction,
  unpromoteLeadAction,
} from "@/app/(app)/leads/actions"
import {
  canPromote,
  PROMOTE_SKIP_COPY,
} from "@/lib/lead-actions"
import type { LeadDetail } from "@/lib/leads"
import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"

type PromoteControlsProps = {
  detail: LeadDetail
  disabled?: boolean
  onChanged: () => void
}

export function PromoteControls({
  detail,
  disabled,
  onChanged,
}: PromoteControlsProps) {
  const [busy, setBusy] = useState(false)

  const promoteVerdict = canPromote({
    status: detail.status,
    netlifyUrl: detail.netlify_url,
    pageDeployStatus: detail.landing_pages?.deploy_status ?? null,
  })

  const promoteDisabled =
    disabled || busy || detail.status !== "deployed" || !promoteVerdict.ok

  const promoteReason =
    detail.status !== "deployed"
      ? "Only deployed leads can be promoted"
      : !promoteVerdict.ok
        ? PROMOTE_SKIP_COPY[promoteVerdict.reason]
        : null

  const unpromoteDisabled = disabled || busy || detail.status !== "ready"
  const unpromoteReason =
    detail.status !== "ready" ? "Only ready leads can be returned to deployed" : null

  const promoteButton = (
    <Button
      size="sm"
      variant="default"
      disabled={promoteDisabled}
      onClick={async () => {
        setBusy(true)
        try {
          const result = await promoteLeadAction(detail.id)
          if (result.error) toast.error(result.error)
          else {
            toast.success("Promoted to Ready")
            onChanged()
          }
        } finally {
          setBusy(false)
        }
      }}
    >
      Promote to Ready
    </Button>
  )

  const unpromoteButton = (
    <Button
      size="sm"
      variant="outline"
      disabled={unpromoteDisabled}
      onClick={async () => {
        setBusy(true)
        try {
          const result = await unpromoteLeadAction(detail.id)
          if (result.error) toast.error(result.error)
          else {
            toast.success("Returned to Deployed")
            onChanged()
          }
        } finally {
          setBusy(false)
        }
      }}
    >
      Return to Deployed
    </Button>
  )

  return (
    <div className="flex flex-wrap gap-2">
      {promoteReason ? (
        <Tooltip>
          <TooltipTrigger render={promoteButton} />
          <TooltipContent>{promoteReason}</TooltipContent>
        </Tooltip>
      ) : (
        promoteButton
      )}
      {unpromoteReason ? (
        <Tooltip>
          <TooltipTrigger render={unpromoteButton} />
          <TooltipContent>{unpromoteReason}</TooltipContent>
        </Tooltip>
      ) : (
        unpromoteButton
      )}
    </div>
  )
}
