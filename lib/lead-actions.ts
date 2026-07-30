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

export const PROMOTE_SKIP_REASONS = [
  "not_found",
  "not_deployed",
  "no_live_url",
  "page_unpublished",
] as const

export type PromoteSkipReason = (typeof PROMOTE_SKIP_REASONS)[number]

export const PROMOTE_SKIP_COPY: Record<PromoteSkipReason, string> = {
  not_found: "Lead not found",
  not_deployed: "No longer deployed",
  no_live_url: "No live landing URL",
  page_unpublished: "Landing page unpublished",
}

export function canPromote(input: {
  status: LeadStatus
  netlifyUrl: string | null
  pageDeployStatus: string | null
}): { ok: true } | { ok: false; reason: PromoteSkipReason } {
  if (input.status !== "deployed") {
    return { ok: false, reason: "not_deployed" }
  }
  if (!input.netlifyUrl) {
    return { ok: false, reason: "no_live_url" }
  }
  if (input.pageDeployStatus === "removed") {
    return { ok: false, reason: "page_unpublished" }
  }
  return { ok: true }
}
