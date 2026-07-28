"use client"

import { canRetry } from "@/lib/lead-actions"
import { PIPELINE_STEPS, type PipelineStep } from "@/lib/pipeline-types"
import type { LeadStatus } from "@/lib/campaign-types"
import { retryStepAction } from "@/app/(app)/leads/actions"
import { RetryStepButton } from "@/components/leads/retry-step-button"
import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { toast } from "sonner"

type RetryControlsProps = {
  campaignLeadId: string
  status: LeadStatus
  disabled?: boolean
}

function ineligibleReason(
  status: LeadStatus,
  step: PipelineStep,
): string | null {
  if (canRetry(status, "step", step)) return null
  if (status === "skipped" && step !== "recording") {
    return "Skipped leads can only restart at recording"
  }
  if (status === "ready" && step !== "deploy") {
    return "Ready leads can only re-deploy"
  }
  return `Cannot retry ${step} from status ${status}`
}

export function RetryControls({
  campaignLeadId,
  status,
  disabled,
}: RetryControlsProps) {
  return (
    <div className="flex flex-wrap gap-2">
      {PIPELINE_STEPS.map((step) => {
        const eligible = canRetry(status, "step", step)
        const reason = ineligibleReason(status, step)
        const button = (
          <RetryStepButton
            key={step}
            campaignLeadId={campaignLeadId}
            step={step}
            disabled={disabled || !eligible}
          />
        )

        if (eligible || !reason) return button

        return (
          <Tooltip key={step}>
            <TooltipTrigger render={button} />
            <TooltipContent>{reason}</TooltipContent>
          </Tooltip>
        )
      })}
      <Button
        size="sm"
        variant="outline"
        disabled={disabled || !canRetry(status, "restart")}
        onClick={async () => {
          const result = await retryStepAction(campaignLeadId, "restart")
          if (result.error) toast.error(result.error)
          else toast.success("Full restart queued")
        }}
      >
        Full restart
      </Button>
      <Button
        size="sm"
        variant="outline"
        disabled={disabled || !canRetry(status, "resume")}
        onClick={async () => {
          const result = await retryStepAction(campaignLeadId, "resume")
          if (result.error) toast.error(result.error)
          else toast.success("Resume queued")
        }}
      >
        Resume
      </Button>
    </div>
  )
}
