import "server-only"

import { getSupabaseAdmin } from "@/lib/supabase"
import { getQueue } from "@/lib/queue"
import { planClearQueue } from "@/lib/queue-clear-plan"

const CLEAR_MESSAGE =
  "Queue cleared by operator — this lead was removed from the queue before it started. Retry to put it back."

export type ClearQueueResult = {
  removedCount: number
  removeFailedCount: number
  pausedLeadCount: number
}

export { planClearQueue } from "@/lib/queue-clear-plan"

export async function clearQueue(): Promise<ClearQueueResult> {
  const queue = getQueue()
  const jobs = await queue.getJobs(["waiting", "delayed"], 0, -1)
  const { leadIds: removedLeadIds, removeFailedCount } = await planClearQueue(jobs)

  if (removedLeadIds.length === 0) {
    return { removedCount: 0, removeFailedCount, pausedLeadCount: 0 }
  }

  const { data: pausedRows, error: updateError } = await getSupabaseAdmin()
    .from("campaign_leads")
    .update({
      status: "paused",
      error_code: null,
      error_detail: null,
    })
    .in("id", removedLeadIds)
    .eq("status", "queued")
    .select("id")

  if (updateError) {
    throw new Error(`Failed to pause cleared leads: ${updateError.message}`)
  }

  const pausedIds = (pausedRows ?? []).map((row) => row.id)
  if (pausedIds.length > 0) {
    const { error: eventError } = await getSupabaseAdmin()
      .from("pipeline_events")
      .insert(
        pausedIds.map((leadId) => ({
          campaign_lead_id: leadId,
          kind: "paused" as const,
          message: CLEAR_MESSAGE,
        })),
      )
    if (eventError) {
      throw new Error(
        `Failed to write pause events: ${eventError.message}`,
      )
    }
  }

  const { error: logError } = await getSupabaseAdmin().from("logs").insert({
    level: "info",
    scope: "web",
    message: `Queue cleared — ${removedLeadIds.length} lead(s) removed from queue and paused`,
    meta: { removed_count: removedLeadIds.length },
  })
  if (logError) {
    console.error("[queue-clear] failed to write log:", logError.message)
  }

  return {
    removedCount: removedLeadIds.length,
    removeFailedCount,
    pausedLeadCount: pausedIds.length,
  }
}
