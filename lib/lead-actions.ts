import type { Database } from "@/lib/database.types"
import type { PipelineStep } from "@/lib/pipeline-types"

export type LeadStatus = Database["public"]["Enums"]["lead_status"]
export type RetryMode = "resume" | "restart" | "step"

export const RETRYABLE_STATUSES: readonly LeadStatus[] = [
  "failed",
  "paused",
  "deployed",
  "processing",
] as const

export type RetryPatch = {
  current_step?: PipelineStep
  video_id?: string | null
  landing_page_id?: string | null
  netlify_url?: string | null
  deployed_at?: string | null
  deployed_dry_run?: boolean
}

export function buildRetryPatch(
  mode: RetryMode,
  step?: PipelineStep,
): RetryPatch {
  const patch: RetryPatch = {}

  if (mode === "restart") {
    patch.current_step = "recording"
    patch.video_id = null
    patch.landing_page_id = null
    return patch
  }

  if (mode === "step") {
    if (!step) {
      throw new Error("step is required for mode=step")
    }
    patch.current_step = step
    if (step === "merge") {
      patch.video_id = null
    }
    if (step === "page") {
      patch.landing_page_id = null
    }
    if (step === "deploy") {
      patch.netlify_url = null
      patch.deployed_at = null
      patch.deployed_dry_run = false
    }
  }

  return patch
}

export function canRetry(
  status: LeadStatus,
  mode: RetryMode,
  step?: PipelineStep,
): boolean {
  if (mode === "step" && step === "deploy" && status === "ready") {
    return true
  }
  if (mode === "step" && step === "recording" && status === "skipped") {
    return true
  }
  return RETRYABLE_STATUSES.includes(status)
}
