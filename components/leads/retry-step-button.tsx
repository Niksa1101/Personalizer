"use client"

import { toast } from "sonner"

import { retryStepAction } from "@/app/(app)/leads/actions"
import { Button } from "@/components/ui/button"
import type { PipelineStep } from "@/lib/pipeline-types"

const STEP_LABELS: Record<PipelineStep, string> = {
  recording: "Re-record",
  merge: "Re-merge",
  page: "Re-generate page",
  deploy: "Re-deploy",
}

type RetryStepButtonProps = {
  campaignLeadId: string
  step: PipelineStep
  label?: string
  disabled?: boolean
  size?: "sm" | "default"
  variant?: "outline" | "secondary" | "default"
}

export function RetryStepButton({
  campaignLeadId,
  step,
  label,
  disabled,
  size = "sm",
  variant = "outline",
}: RetryStepButtonProps) {
  const text = label ?? STEP_LABELS[step]

  return (
    <Button
      size={size}
      variant={variant}
      disabled={disabled}
      onClick={async () => {
        const result = await retryStepAction(campaignLeadId, "step", step)
        if (result.error) toast.error(result.error)
        else toast.success(`Queued ${text}`)
      }}
    >
      {text}
    </Button>
  )
}

export { STEP_LABELS }
