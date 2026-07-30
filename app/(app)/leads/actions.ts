"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { verifySession } from "@/lib/dal"
import {
  canRetry,
  PROMOTE_SKIP_COPY,
  type PromoteSkipReason,
} from "@/lib/lead-actions"
import { leadEditSchema } from "@/lib/lead-edit"
import type { LeadFilters } from "@/lib/lead-filters"
import {
  deleteLead,
  deriveRequeueModeForLead,
  getLeadDetail,
  LeadMutationError,
  promoteLeads,
  refetchLeadRows,
  requeueLead,
  unpromoteLead,
  unpublishLead,
  updateLead,
  type LeadDetail,
  type LeadListRow,
} from "@/lib/leads"
import { retryCampaignLead, PipelineControlError } from "@/lib/pipeline-control"
import type { PipelineStep } from "@/lib/pipeline-types"
import { getSupabaseAdmin } from "@/lib/supabase"

export type LeadActionState = {
  error?: string
  fieldErrors?: Record<string, string>
  conflictRef?: string
  saved?: boolean
}

export type BulkLeadOutcome = {
  id: string
  ref: string
  outcome: "success" | "skipped" | "failed"
  reason?: string
}

export type BulkActionResult = {
  outcomes: BulkLeadOutcome[]
}

function zodFieldErrors(error: z.ZodError): Record<string, string> {
  const fieldErrors: Record<string, string> = {}
  for (const issue of error.issues) {
    const key = issue.path[0]
    if (typeof key === "string" && !fieldErrors[key]) {
      fieldErrors[key] = issue.message
    }
  }
  return fieldErrors
}

function actionError(message: string): LeadActionState {
  return { error: message }
}

export async function loadLeadDetailAction(
  campaignLeadId: string,
): Promise<LeadDetail | null> {
  await verifySession()
  return getLeadDetail(campaignLeadId)
}

export async function refetchLeadRowsAction(
  ids: string[],
  filters: LeadFilters,
): Promise<LeadListRow[]> {
  await verifySession()
  return refetchLeadRows(ids, filters)
}

export async function updateLeadAction(
  campaignLeadId: string,
  _prev: LeadActionState,
  formData: FormData,
): Promise<LeadActionState> {
  await verifySession()

  const raw = Object.fromEntries(formData.entries())
  let parsed
  try {
    parsed = leadEditSchema.parse(raw)
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { fieldErrors: zodFieldErrors(error) }
    }
    throw error
  }

  try {
    await updateLead(campaignLeadId, parsed)
    revalidatePath("/leads")
    return { saved: true }
  } catch (error) {
    if (error instanceof LeadMutationError) {
      if (error.field) {
        return {
          fieldErrors: { [error.field]: error.message },
          conflictRef:
            typeof error.meta?.conflictRef === "string"
              ? error.meta.conflictRef
              : undefined,
        }
      }
      return actionError(error.message)
    }
    return actionError(
      error instanceof Error ? error.message : "Failed to update lead",
    )
  }
}

export async function requeueLeadAction(
  campaignLeadId: string,
): Promise<LeadActionState> {
  await verifySession()

  try {
    const mode = await deriveRequeueModeForLead(campaignLeadId)
    await requeueLead(campaignLeadId, mode)
    revalidatePath("/leads")
    return {}
  } catch (error) {
    if (error instanceof PipelineControlError) {
      return actionError(error.message)
    }
    if (error instanceof LeadMutationError) {
      return actionError(error.message)
    }
    return actionError(
      error instanceof Error ? error.message : "Failed to re-queue lead",
    )
  }
}

export async function retryStepAction(
  campaignLeadId: string,
  mode: "resume" | "restart" | "step",
  step?: PipelineStep,
): Promise<LeadActionState> {
  await verifySession()

  try {
    await retryCampaignLead(campaignLeadId, mode, step)
    revalidatePath("/leads")
    return {}
  } catch (error) {
    if (error instanceof PipelineControlError) {
      return actionError(error.message)
    }
    return actionError(
      error instanceof Error ? error.message : "Failed to retry lead",
    )
  }
}

export async function unpublishLeadAction(
  campaignLeadId: string,
): Promise<LeadActionState> {
  await verifySession()

  try {
    await unpublishLead(campaignLeadId)
    revalidatePath("/leads")
    return {}
  } catch (error) {
    return actionError(
      error instanceof Error ? error.message : "Failed to unpublish page",
    )
  }
}

export async function deleteLeadAction(
  campaignLeadId: string,
  retain: boolean,
): Promise<LeadActionState> {
  await verifySession()

  try {
    await deleteLead(campaignLeadId, retain)
    revalidatePath("/leads")
    return {}
  } catch (error) {
    return actionError(
      error instanceof Error ? error.message : "Failed to remove lead",
    )
  }
}

async function loadLeadRetryContext(id: string) {
  const { data, error } = await getSupabaseAdmin()
    .from("campaign_leads")
    .select(
      "id, status, error_code, leads(ref), campaigns(intro_video_id)",
    )
    .eq("id", id)
    .maybeSingle()

  if (error) throw new Error(error.message)
  return data
}

function bulkSkipReason(
  row: NonNullable<Awaited<ReturnType<typeof loadLeadRetryContext>>>,
): string | null {
  if (!canRetry(row.status, "resume")) {
    if (row.status === "processing") return "Lead is processing — watch it in the drawer"
    if (row.status === "ready") return "Lead is ready — use per-step deploy retry in the drawer"
    if (row.status === "skipped") return "Skipped leads need a valid website URL first"
    return `Status '${row.status}' cannot be bulk-retried`
  }
  if (
    row.status === "paused" &&
    row.error_code === "intro_missing" &&
    !(row.campaigns as { intro_video_id: string | null }).intro_video_id
  ) {
    return "Campaign has no intro assigned"
  }
  return null
}

export async function bulkRetryAction(
  ids: string[],
): Promise<BulkActionResult> {
  await verifySession()

  const outcomes: BulkLeadOutcome[] = []

  for (const id of ids) {
    const row = await loadLeadRetryContext(id)
    const ref = (row?.leads as { ref: string } | null)?.ref ?? id

    if (!row) {
      outcomes.push({ id, ref, outcome: "skipped", reason: "Lead not found" })
      continue
    }

    const skipReason = bulkSkipReason(row)
    if (skipReason) {
      outcomes.push({ id, ref, outcome: "skipped", reason: skipReason })
      continue
    }

    try {
      await retryCampaignLead(id, "resume")
      outcomes.push({ id, ref, outcome: "success" })
    } catch (error) {
      if (error instanceof PipelineControlError && error.status === 409) {
        outcomes.push({ id, ref, outcome: "skipped", reason: error.message })
      } else {
        outcomes.push({
          id,
          ref,
          outcome: "failed",
          reason: error instanceof Error ? error.message : "Retry failed",
        })
      }
    }
  }

  revalidatePath("/leads")
  return { outcomes }
}

export async function bulkDeleteAction(
  ids: string[],
  retain: boolean,
): Promise<BulkActionResult> {
  await verifySession()

  const outcomes: BulkLeadOutcome[] = []

  for (const id of ids) {
    const row = await loadLeadRetryContext(id)
    const ref = (row?.leads as { ref: string } | null)?.ref ?? id

    if (!row) {
      outcomes.push({ id, ref, outcome: "skipped", reason: "Lead not found" })
      continue
    }

    try {
      await deleteLead(id, retain)
      outcomes.push({ id, ref, outcome: "success" })
    } catch (error) {
      outcomes.push({
        id,
        ref,
        outcome: "failed",
        reason: error instanceof Error ? error.message : "Delete failed",
      })
    }
  }

  revalidatePath("/leads")
  return { outcomes }
}

const PROMOTE_CAP = 200

function mapPromoteReason(reason: string | null | undefined): string | undefined {
  if (!reason) return undefined
  if (reason in PROMOTE_SKIP_COPY) {
    return PROMOTE_SKIP_COPY[reason as PromoteSkipReason]
  }
  return reason
}

export async function bulkPromoteAction(
  ids: string[],
): Promise<BulkActionResult> {
  await verifySession()

  const unique = [...new Set(ids)]
  if (unique.length > PROMOTE_CAP) {
    return {
      outcomes: unique.map((id) => ({
        id,
        ref: id,
        outcome: "skipped" as const,
        reason: `Select ${PROMOTE_CAP} leads or fewer to promote at once`,
      })),
    }
  }

  try {
    const rows = await promoteLeads(unique, "bulk")
    const outcomes: BulkLeadOutcome[] = rows.map((row) => ({
      id: row.campaign_lead_id,
      ref: row.lead_ref || row.campaign_lead_id,
      outcome:
        row.outcome === "success"
          ? "success"
          : row.outcome === "skipped"
            ? "skipped"
            : "failed",
      reason: mapPromoteReason(row.reason),
    }))
    revalidatePath("/leads")
    return { outcomes }
  } catch (error) {
    if (error instanceof Error && error.message.includes("23514")) {
      return {
        outcomes: unique.map((id) => ({
          id,
          ref: id,
          outcome: "skipped",
          reason: "Constraint prevented promotion",
        })),
      }
    }
    throw error
  }
}

export async function promoteLeadAction(
  campaignLeadId: string,
): Promise<LeadActionState> {
  await verifySession()

  try {
    const rows = await promoteLeads([campaignLeadId], "drawer")
    const row = rows[0]
    if (!row || row.outcome !== "success") {
      return actionError(
        mapPromoteReason(row?.reason ?? null) ?? "Lead could not be promoted",
      )
    }
    revalidatePath("/leads")
    return {}
  } catch (error) {
    if (error instanceof Error && error.message.includes("23514")) {
      return actionError("Lead could not be promoted — URL constraint")
    }
    return actionError(
      error instanceof Error ? error.message : "Failed to promote lead",
    )
  }
}

export async function unpromoteLeadAction(
  campaignLeadId: string,
): Promise<LeadActionState> {
  await verifySession()

  try {
    await unpromoteLead(campaignLeadId)
    revalidatePath("/leads")
    return {}
  } catch (error) {
    const message = error instanceof Error ? error.message : ""
    return actionError(
      message.includes("is not ready")
        ? "This lead is no longer Ready — refresh and try again"
        : "Failed to return lead to Deployed",
    )
  }
}
