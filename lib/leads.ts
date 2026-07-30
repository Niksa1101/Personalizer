import "server-only"

import { removeFile } from "@/lib/local-file"
import type { LeadEditInput } from "@/lib/lead-edit"
import {
  buildLeadSearchOrFilter,
  LEADS_PAGE_SIZE,
  type LeadFilters,
  type LeadSortColumn,
} from "@/lib/lead-filters"
import { retryCampaignLead } from "@/lib/pipeline-control"
import type { PipelineEventMeta } from "@/lib/pipeline-types"
import { requestSiteSync } from "@/lib/site-sync"
import { resolveMany } from "@/lib/settings"
import { storageAbs } from "@/lib/storage"
import { getSupabaseAdmin, type PostgrestFilterable } from "@/lib/supabase"
import { normalizeWebsiteUrl } from "@/lib/website-url"
import type { Database } from "@/lib/database.types"

type CampaignLeadRow = Database["public"]["Tables"]["campaign_leads"]["Row"]
type LeadRow = Database["public"]["Tables"]["leads"]["Row"]
type CampaignRow = Database["public"]["Tables"]["campaigns"]["Row"]
type LandingPageRow = Database["public"]["Tables"]["landing_pages"]["Row"]
type PipelineEventRow = Database["public"]["Tables"]["pipeline_events"]["Row"]
type VideoRow = Database["public"]["Tables"]["videos"]["Row"]
type RecordingRow = Database["public"]["Tables"]["recordings"]["Row"]

const LEAD_LIST_SELECT = `
  id,
  status,
  current_step,
  error_bucket,
  error_code,
  error_detail,
  netlify_url,
  deployed_dry_run,
  attempt_count,
  updated_at,
  slug,
  merge_layout,
  pip_scale,
  promoted_at,
  video_id,
  recording_id,
  landing_page_id,
  campaign_id,
  batch_id,
  leads!inner (
    id,
    ref,
    company,
    full_name,
    first_name,
    last_name,
    website_url,
    domain,
    email,
    phone,
    city,
    state,
    country,
    updated_at
  ),
  campaigns!inner (
    id,
    name,
    ref,
    archived_at,
    intro_video_id
  ),
  landing_pages!campaign_leads_landing_page_fk (
    deploy_status,
    path,
    unpublished_at
  )
` as const

export type LeadListRow = CampaignLeadRow & {
  leads: LeadRow
  campaigns: CampaignRow
  landing_pages: Pick<LandingPageRow, "deploy_status" | "path" | "unpublished_at"> | null
}

export type LeadListResult = {
  rows: LeadListRow[]
  total: number
  page: number
  pageSize: number
  pageCount: number
}

export type LeadDetail = LeadListRow & {
  events: PipelineEventRow[]
  video: VideoRow | null
  recording: RecordingRow | null
  otherCampaigns: Array<{ id: string; name: string; ref: string }>
  maxStretchFactor: number
  pausedReason: { sentence: string; createdAt: string } | null
}

export type CampaignOption = {
  id: string
  name: string
  ref: string
}

/**
 * Shared prefix of both URL-change notes. `deriveRequeueModeForLead` matches on
 * it, so the two writers and the reader must not drift — hence the constant
 * rather than three copies of the literal.
 */
const WEBSITE_URL_CHANGED_NOTE = "Website URL changed"

export class LeadMutationError extends Error {
  readonly code: string
  readonly field?: string
  readonly meta?: Record<string, unknown>

  constructor(
    code: string,
    message: string,
    options?: { field?: string; meta?: Record<string, unknown> },
  ) {
    super(message)
    this.name = "LeadMutationError"
    this.code = code
    this.field = options?.field
    this.meta = options?.meta
  }
}

function applyLeadFilters<T extends object>(query: T, filters: LeadFilters): T {
  let q = query as unknown as PostgrestFilterable

  if (filters.campaignId) {
    q = q.eq("campaign_id", filters.campaignId)
  }

  if (filters.status) {
    q = q.eq("status", filters.status)
  }

  if (filters.bucket) {
    q = q.eq("error_bucket", filters.bucket)
  }

  if (filters.batchId) {
    q = q.eq("batch_id", filters.batchId)
  }

  if (!filters.includeArchived) {
    q = q.is("campaigns.archived_at", null)
  }

  if (filters.search) {
    q = q.or(buildLeadSearchOrFilter(filters.search), {
      referencedTable: "leads",
    })
  }

  return q as unknown as T
}

function sortConfig(
  sort: LeadSortColumn,
): { column: string; referencedTable?: string } {
  switch (sort) {
    case "ref":
      return { column: "ref", referencedTable: "leads" }
    case "company":
      return { column: "company", referencedTable: "leads" }
    case "website":
      return { column: "website_url", referencedTable: "leads" }
    case "city":
      return { column: "city", referencedTable: "leads" }
    case "campaign":
      return { column: "name", referencedTable: "campaigns" }
    case "status":
      return { column: "status" }
    case "landing_url":
      return { column: "netlify_url" }
    case "updated_at":
    default:
      return { column: "updated_at" }
  }
}

export async function listCampaignOptions(): Promise<CampaignOption[]> {
  const { data, error } = await getSupabaseAdmin()
    .from("campaigns")
    .select("id, name, ref")
    .is("archived_at", null)
    .order("name")

  if (error) throw new Error(`Failed to list campaigns: ${error.message}`)
  return data ?? []
}

export async function listLeads(filters: LeadFilters): Promise<LeadListResult> {
  const from = (filters.page - 1) * LEADS_PAGE_SIZE
  const to = from + LEADS_PAGE_SIZE - 1
  const { column, referencedTable } = sortConfig(filters.sort)

  let query = getSupabaseAdmin()
    .from("campaign_leads")
    .select(LEAD_LIST_SELECT, { count: "exact" })

  query = applyLeadFilters(query, filters)

  if (referencedTable) {
    query = query.order(column, {
      ascending: filters.order === "asc",
      referencedTable,
    })
  } else {
    query = query.order(column, { ascending: filters.order === "asc" })
  }

  query = query.order("id", { ascending: false }).range(from, to)

  const { data, error, count } = await query

  if (error) throw new Error(`Failed to list leads: ${error.message}`)

  const total = count ?? 0
  const pageCount = Math.max(1, Math.ceil(total / LEADS_PAGE_SIZE))

  return {
    rows: (data ?? []) as unknown as LeadListRow[],
    total,
    page: filters.page,
    pageSize: LEADS_PAGE_SIZE,
    pageCount,
  }
}

export async function refetchLeadRows(
  ids: string[],
  filters: LeadFilters,
): Promise<LeadListRow[]> {
  if (ids.length === 0) return []

  let query = getSupabaseAdmin()
    .from("campaign_leads")
    .select(LEAD_LIST_SELECT)
    .in("id", ids)

  query = applyLeadFilters(query, filters)

  const { data, error } = await query
  if (error) throw new Error(`Failed to refetch leads: ${error.message}`)
  return (data ?? []) as unknown as LeadListRow[]
}

export async function getLeadDetail(
  campaignLeadId: string,
): Promise<LeadDetail | null> {
  const { data, error } = await getSupabaseAdmin()
    .from("campaign_leads")
    .select(LEAD_LIST_SELECT)
    .eq("id", campaignLeadId)
    .maybeSingle()

  if (error) throw new Error(`Failed to load lead detail: ${error.message}`)
  if (!data) return null

  const row = data as unknown as LeadListRow

  const [eventsResult, videoResult, recordingResult, otherCampaignsResult, settings] =
    await Promise.all([
      getSupabaseAdmin()
        .from("pipeline_events")
        .select("*")
        .eq("campaign_lead_id", campaignLeadId)
        .order("created_at", { ascending: false }),
      row.video_id
        ? getSupabaseAdmin()
            .from("videos")
            .select("*")
            .eq("id", row.video_id)
            .maybeSingle()
        : Promise.resolve({ data: null, error: null }),
      row.recording_id
        ? getSupabaseAdmin()
            .from("recordings")
            .select("*")
            .eq("id", row.recording_id)
            .maybeSingle()
        : Promise.resolve({ data: null, error: null }),
      getSupabaseAdmin()
        .from("campaign_leads")
        .select("campaigns(id, name, ref)")
        .eq("lead_id", row.leads.id)
        .neq("id", campaignLeadId),
      resolveMany(["merge.max_stretch_factor"]),
    ])

  if (eventsResult.error) {
    throw new Error(`Failed to load events: ${eventsResult.error.message}`)
  }
  if (videoResult.error) {
    throw new Error(`Failed to load video: ${videoResult.error.message}`)
  }
  if (recordingResult.error) {
    throw new Error(`Failed to load recording: ${recordingResult.error.message}`)
  }
  if (otherCampaignsResult.error) {
    throw new Error(
      `Failed to load other campaigns: ${otherCampaignsResult.error.message}`,
    )
  }

  const otherCampaigns =
    otherCampaignsResult.data?.flatMap((entry) => {
      const campaign = entry.campaigns as unknown as {
        id: string
        name: string
        ref: string
      } | null
      return campaign ? [campaign] : []
    }) ?? []

  const events = eventsResult.data ?? []
  const pausedReason =
    row.status === "paused" && !row.error_code
      ? (() => {
          const latestPaused = events.find((event) => event.kind === "paused")
          return latestPaused
            ? {
                sentence: latestPaused.message,
                createdAt: latestPaused.created_at,
              }
            : null
        })()
      : null

  return {
    ...row,
    events,
    video: videoResult.data,
    recording: recordingResult.data,
    otherCampaigns,
    maxStretchFactor: settings["merge.max_stretch_factor"],
    pausedReason,
  }
}

async function purgeLeadRecording(recordingId: string): Promise<void> {
  const { data: existing, error: readError } = await getSupabaseAdmin()
    .from("recordings")
    .select("local_path")
    .eq("id", recordingId)
    .maybeSingle()

  if (readError) {
    throw new Error(`Failed to read recording: ${readError.message}`)
  }
  if (!existing) return

  const now = new Date().toISOString()
  const { error } = await getSupabaseAdmin()
    .from("recordings")
    .update({ purged_at: now, local_path: null })
    .eq("id", recordingId)

  if (error) throw new Error(`Failed to purge recording: ${error.message}`)

  if (existing.local_path) {
    await removeFile(storageAbs(existing.local_path))
  }

  const { data: otherLeads } = await getSupabaseAdmin()
    .from("campaign_leads")
    .select("id")
    .eq("recording_id", recordingId)

  for (const lead of otherLeads ?? []) {
    await getSupabaseAdmin().from("pipeline_events").insert({
      campaign_lead_id: lead.id,
      kind: "note",
      message: `${WEBSITE_URL_CHANGED_NOTE} — recording purged; will re-capture on next run.`,
    })
  }
}

export async function updateLead(
  campaignLeadId: string,
  input: LeadEditInput,
): Promise<{ websiteUrlChanged: boolean; hasVideo: boolean }> {
  const { data: row, error: loadError } = await getSupabaseAdmin()
    .from("campaign_leads")
    .select(
      "id, lead_id, recording_id, video_id, leads!inner(id, updated_at, website_url)",
    )
    .eq("id", campaignLeadId)
    .maybeSingle()

  if (loadError) throw new Error(`Failed to load lead: ${loadError.message}`)
  if (!row) throw new LeadMutationError("not_found", "Lead not found")

  const lead = row.leads as unknown as {
    id: string
    updated_at: string
    website_url: string | null
  }
  const previousWebsiteUrl = lead.website_url
  const hasVideo = row.video_id != null
  if (lead.updated_at !== input.leads_updated_at) {
    throw new LeadMutationError(
      "stale",
      "This lead was changed elsewhere. Reload and try again.",
    )
  }

  let normalizedUrl = input.website_url
  if (normalizedUrl) {
    normalizedUrl = normalizeWebsiteUrl(normalizedUrl)
    if (!normalizedUrl) {
      throw new LeadMutationError(
        "invalid_url",
        "Website URL is not valid.",
        { field: "website_url" },
      )
    }
  }

  let domain: string | null = null
  if (normalizedUrl) {
    const { data: domainValue, error: domainError } = await getSupabaseAdmin().rpc(
      "normalize_domain",
      { raw: new URL(normalizedUrl).hostname },
    )
    if (domainError) {
      throw new Error(`Failed to normalize domain: ${domainError.message}`)
    }
    domain = domainValue
  }

  const websiteUrlChanged =
    (normalizedUrl ?? null) !== (previousWebsiteUrl ?? null)

  const { error: leadUpdateError } = await getSupabaseAdmin()
    .from("leads")
    .update({
      first_name: input.first_name,
      last_name: input.last_name,
      full_name: input.full_name,
      company: input.company,
      email: input.email,
      phone: input.phone,
      website_url: normalizedUrl,
      domain,
      city: input.city,
      state: input.state,
      country: input.country,
    })
    .eq("id", lead.id)
    .eq("updated_at", input.leads_updated_at)

  if (leadUpdateError) {
    if (leadUpdateError.code === "23505" && domain) {
      const { data: conflict } = await getSupabaseAdmin()
        .from("leads")
        .select("ref")
        .eq("domain", domain)
        .maybeSingle()
      throw new LeadMutationError(
        "domain_conflict",
        conflict?.ref
          ? `Another lead (${conflict.ref}) already uses ${domain}.`
          : "Another lead already uses this domain.",
        { field: "website_url", meta: { conflictRef: conflict?.ref, domain } },
      )
    }
    if (leadUpdateError.code === "23514") {
      // `leads_identifiable_ck` is `domain IS NOT NULL OR email IS NOT NULL`
      // (core_tables.sql). The remedy must name those two: a company name does
      // not satisfy the constraint, so offering it sent the operator to a field
      // that could not clear the error.
      throw new LeadMutationError(
        "identifiable",
        "A lead needs a website URL or an email address — clearing both leaves nothing to dedupe on.",
        { field: "website_url" },
      )
    }
    throw new Error(`Failed to update lead: ${leadUpdateError.message}`)
  }

  const { error: clUpdateError } = await getSupabaseAdmin()
    .from("campaign_leads")
    .update({
      merge_layout: input.merge_layout,
      pip_scale: input.pip_scale,
    })
    .eq("id", campaignLeadId)

  if (clUpdateError) {
    throw new Error(`Failed to update campaign lead: ${clUpdateError.message}`)
  }

  if (websiteUrlChanged && row.recording_id) {
    await purgeLeadRecording(row.recording_id)
  }

  if (websiteUrlChanged) {
    await getSupabaseAdmin().from("pipeline_events").insert({
      campaign_lead_id: campaignLeadId,
      kind: "note",
      message: `${WEBSITE_URL_CHANGED_NOTE} — re-queue will restart from recording.`,
    })
  }

  return { websiteUrlChanged, hasVideo }
}

export async function deriveRequeueModeForLead(
  campaignLeadId: string,
): Promise<RequeueMode> {
  const { data, error } = await getSupabaseAdmin()
    .from("campaign_leads")
    .select("status, video_id, recording_id, recordings(purged_at)")
    .eq("id", campaignLeadId)
    .maybeSingle()

  if (error) throw new Error(`Failed to load lead: ${error.message}`)
  if (!data) throw new LeadMutationError("not_found", "Lead not found")

  // D38/D39: `canRetry` admits `skipped` only for step=recording, so deriving
  // resume or restart here 409s. Resume would also be wrong on its own terms —
  // it leaves `current_step` at the import default, which is the one value not
  // to trust on a lead that never ran.
  if (data.status === "skipped") {
    return { kind: "step", step: "recording" }
  }

  const recording = data.recordings as { purged_at: string | null } | null
  const recordingPurged = Boolean(data.recording_id && recording?.purged_at)
  const hasVideo = data.video_id != null

  // Only a URL change since the lead was last queued counts. Unbounded, the
  // note matches forever, so every later re-queue would derive restart — a
  // full re-record — after an edit that touched nothing but a name.
  //
  // The cutoff is the last `resumed` event, NOT `campaign_leads.queued_at`:
  // queued_at is stamped from the app clock (`pipeline-control.ts`) while
  // `created_at` defaults to the database clock, so comparing them across the
  // two makes this flip on sub-second skew. Both timestamps here come from the
  // same table and the same clock.
  const { data: lastResumed } = await getSupabaseAdmin()
    .from("pipeline_events")
    .select("created_at")
    .eq("campaign_lead_id", campaignLeadId)
    .eq("kind", "resumed")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  let urlChangeQuery = getSupabaseAdmin()
    .from("pipeline_events")
    .select("id")
    .eq("campaign_lead_id", campaignLeadId)
    .eq("kind", "note")
    .ilike("message", `${WEBSITE_URL_CHANGED_NOTE}%`)
  if (lastResumed?.created_at) {
    urlChangeQuery = urlChangeQuery.gt("created_at", lastResumed.created_at)
  }
  const { data: urlChangeNote } = await urlChangeQuery.limit(1).maybeSingle()

  const websiteUrlChanged = recordingPurged || Boolean(urlChangeNote)
  return deriveRequeueMode(websiteUrlChanged, hasVideo)
}

export type RequeueMode =
  | { kind: "restart" }
  | { kind: "step"; step: "page" | "recording" }
  | { kind: "resume" }

export function deriveRequeueMode(
  websiteUrlChanged: boolean,
  hasVideo: boolean,
): RequeueMode {
  if (websiteUrlChanged) return { kind: "restart" }
  if (hasVideo) return { kind: "step", step: "page" }
  return { kind: "resume" }
}

export async function requeueLead(
  campaignLeadId: string,
  mode: RequeueMode,
): Promise<void> {
  if (mode.kind === "restart") {
    await retryCampaignLead(campaignLeadId, "restart")
    return
  }
  if (mode.kind === "step") {
    await retryCampaignLead(campaignLeadId, "step", mode.step)
    return
  }
  await retryCampaignLead(campaignLeadId, "resume")
}

export async function unpublishLead(campaignLeadId: string): Promise<void> {
  const { error } = await getSupabaseAdmin().rpc("unpublish_landing_page", {
    p_campaign_lead_id: campaignLeadId,
  })
  if (error) throw new Error(`Failed to unpublish: ${error.message}`)
  await requestSiteSync({ reason: "lead_unpublish", campaignLeadId })
}

export type PromoteOutcomeRow = {
  campaign_lead_id: string
  lead_ref: string
  outcome: string
  reason: string | null
}

export async function promoteLeads(
  ids: string[],
  trigger: "bulk" | "drawer" = "bulk",
): Promise<PromoteOutcomeRow[]> {
  const { data, error } = await getSupabaseAdmin().rpc("promote_campaign_leads", {
    p_ids: ids,
    p_trigger: trigger,
  })
  if (error) throw new Error(`Failed to promote: ${error.message}`)
  return data ?? []
}

export async function unpromoteLead(campaignLeadId: string): Promise<void> {
  const { error } = await getSupabaseAdmin().rpc("unpromote_campaign_lead", {
    p_campaign_lead_id: campaignLeadId,
  })
  if (error) throw new Error(`Failed to unpromote: ${error.message}`)
}

export async function deleteLead(
  campaignLeadId: string,
  retain: boolean,
): Promise<void> {
  const { error } = await getSupabaseAdmin().rpc("delete_lead_retaining_pages", {
    p_campaign_lead_id: campaignLeadId,
    p_retain: retain,
  })
  if (error) throw new Error(`Failed to delete lead: ${error.message}`)
  await requestSiteSync({ reason: "lead_delete", campaignLeadId, retain })
}

export type PipelineEventWithMeta = PipelineEventRow & {
  meta: PipelineEventMeta | null
}
