import "server-only"

import type { Database } from "@/lib/database.types"
import { enqueueLead } from "@/lib/queue"
import type { PipelineStep } from "@/lib/pipeline-types"
import { getSupabaseAdmin } from "@/lib/supabase"

type LeadStatus = Database["public"]["Enums"]["lead_status"]

export class PipelineControlError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = "PipelineControlError"
    this.status = status
  }
}

async function writeResumedEvent(campaignLeadId: string): Promise<void> {
  const { error } = await getSupabaseAdmin().from("pipeline_events").insert({
    campaign_lead_id: campaignLeadId,
    kind: "resumed",
    message: "Lead manually resumed and re-queued.",
  })

  if (error) {
    throw new Error(`Failed to write resumed event: ${error.message}`)
  }
}

async function logEnqueueDidNotLand(campaignLeadId: string): Promise<void> {
  const { error: logError } = await getSupabaseAdmin().from("logs").insert({
    level: "warn",
    scope: "web",
    message: "Enqueue add did not land — job still locked; reconcile will retry",
    campaign_lead_id: campaignLeadId,
  })
  if (logError) {
    console.error("[pipeline-control] failed to write enqueue log:", logError.message)
  }
}

async function transitionToQueued(
  campaignLeadId: string,
  patch: {
    current_step?: PipelineStep
  },
): Promise<void> {
  const update: Database["public"]["Tables"]["campaign_leads"]["Update"] = {
    status: "queued",
    attempt_count: 0,
    error_code: null,
    error_detail: null,
    queued_at: new Date().toISOString(),
    ...patch,
  }

  const { error } = await getSupabaseAdmin()
    .from("campaign_leads")
    .update(update)
    .eq("id", campaignLeadId)

  if (error) {
    throw new Error(`Failed to transition lead to queued: ${error.message}`)
  }

  await writeResumedEvent(campaignLeadId)

  try {
    const landed = await enqueueLead(campaignLeadId)
    if (!landed) {
      await logEnqueueDidNotLand(campaignLeadId)
    }
  } catch (enqueueError) {
    console.error(
      `[pipeline-control] enqueue failed for ${campaignLeadId}:`,
      enqueueError,
    )
    const { error: logError } = await getSupabaseAdmin().from("logs").insert({
      level: "error",
      scope: "web",
      message: "Failed to enqueue lead after resume",
      campaign_lead_id: campaignLeadId,
      meta: {
        error:
          enqueueError instanceof Error
            ? enqueueError.message
            : String(enqueueError),
      },
    })
    if (logError) {
      console.error("[pipeline-control] failed to write enqueue log:", logError.message)
    }
  }
}

export async function resumePausedLeadsForCampaigns(
  campaignIds: string[],
): Promise<void> {
  if (campaignIds.length === 0) return

  const { data: leads, error } = await getSupabaseAdmin()
    .from("campaign_leads")
    .select("id")
    .in("campaign_id", campaignIds)
    .eq("status", "paused")
    .eq("error_code", "intro_missing")

  if (error) {
    throw new Error(`Failed to list paused leads: ${error.message}`)
  }

  for (const lead of leads ?? []) {
    await transitionToQueued(lead.id, {})
  }
}

export async function retryCampaignLead(
  campaignLeadId: string,
  mode: "resume" | "restart" | "step",
  step?: PipelineStep,
): Promise<void> {
  const { data: lead, error } = await getSupabaseAdmin()
    .from("campaign_leads")
    .select("id, status")
    .eq("id", campaignLeadId)
    .maybeSingle()

  if (error) {
    throw new Error(`Failed to load campaign lead: ${error.message}`)
  }
  if (!lead) {
    throw new PipelineControlError(404, "Campaign lead not found")
  }

  const retryableStatuses: LeadStatus[] = ["failed", "paused", "deployed", "processing"]
  if (!retryableStatuses.includes(lead.status)) {
    throw new PipelineControlError(
      409,
      `Lead status '${lead.status}' cannot be retried`,
    )
  }

  const patch: { current_step?: PipelineStep } = {}
  if (mode === "restart") {
    patch.current_step = "recording"
  } else if (mode === "step") {
    if (!step) {
      throw new PipelineControlError(400, "step is required for mode=step")
    }
    patch.current_step = step
  }

  await transitionToQueued(campaignLeadId, patch)
}
