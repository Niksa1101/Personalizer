import "server-only"

import {
  createCampaignSchema,
  EMPTY_STATUS_COUNTS,
  type CampaignListItem,
  type CampaignRow,
  type CreateCampaignInput,
  type IntroVideoOption,
  type LeadStatus,
  type LeadStatusCounts,
  type UpdateCampaignCtaInput,
  type UpdateCampaignGeneralInput,
  type UpdateCampaignMergeInput,
  type UpdateCampaignRecorderInput,
  type UpdateCampaignTemplateInput,
  updateCampaignCtaSchema,
  updateCampaignGeneralSchema,
  updateCampaignMergeSchema,
  updateCampaignRecorderSchema,
  updateCampaignTemplateSchema,
} from "@/lib/campaign-types"
import {
  DEFAULT_LANDING_TEMPLATE,
  SAMPLE_LEAD,
  type SampleLead,
} from "@/lib/landing-template"
import { slugFromName, SLUG_REGEX } from "@/lib/slug"
import { SETTING_DEFAULTS } from "@/lib/settings"
import { getSupabaseAdmin } from "@/lib/supabase"

export type { SampleLead } from "@/lib/landing-template"
export {
  createCampaignSchema,
  updateCampaignCtaSchema,
  updateCampaignGeneralSchema,
  updateCampaignMergeSchema,
  updateCampaignRecorderSchema,
  updateCampaignTemplateSchema,
  CTA_TYPES,
  EMPTY_STATUS_COUNTS,
  LEAD_STATUSES,
  MERGE_LAYOUTS,
  VIEWPORT_PRESETS,
  type CampaignListItem,
  type CampaignRow,
  type CreateCampaignInput,
  type CtaType,
  type IntroVideoOption,
  type LeadStatus,
  type LeadStatusCounts,
  type MergeLayout,
  type UpdateCampaignCtaInput,
  type UpdateCampaignGeneralInput,
  type UpdateCampaignMergeInput,
  type UpdateCampaignRecorderInput,
  type UpdateCampaignTemplateInput,
} from "@/lib/campaign-types"
export { SLUG_REGEX, slugFromName }

export async function slugExists(
  slug: string,
  excludeCampaignId?: string,
): Promise<boolean> {
  let query = getSupabaseAdmin()
    .from("campaigns")
    .select("id")
    .eq("slug", slug)
    .limit(1)

  if (excludeCampaignId) {
    query = query.neq("id", excludeCampaignId)
  }

  const { data, error } = await query
  if (error) throw new Error(`Failed to check slug: ${error.message}`)
  return (data?.length ?? 0) > 0
}

/** Append -2, -3, … until the slug is unique (D8). */
export async function resolveUniqueSlug(
  baseSlug: string,
  excludeCampaignId?: string,
): Promise<string> {
  let candidate = baseSlug || "campaign"
  let suffix = 2

  while (await slugExists(candidate, excludeCampaignId)) {
    candidate = `${baseSlug}-${suffix}`
    suffix += 1
  }

  return candidate
}

/** D9 — slug locks after any campaign_lead has a published netlify_url. */
export async function firstDeployLocked(campaignId: string): Promise<boolean> {
  const { count, error } = await getSupabaseAdmin()
    .from("campaign_leads")
    .select("id", { count: "exact", head: true })
    .eq("campaign_id", campaignId)
    .not("netlify_url", "is", null)

  if (error) {
    throw new Error(`Failed to check deploy lock: ${error.message}`)
  }

  return (count ?? 0) > 0
}

function aggregateStatusCounts(
  rows: Array<{ campaign_id: string; status: LeadStatus }>,
): Map<string, LeadStatusCounts> {
  const map = new Map<string, LeadStatusCounts>()

  for (const row of rows) {
    const counts = map.get(row.campaign_id) ?? EMPTY_STATUS_COUNTS()
    counts[row.status] += 1
    map.set(row.campaign_id, counts)
  }

  return map
}

export async function listCampaigns(options?: {
  includeArchived?: boolean
}): Promise<CampaignListItem[]> {
  let query = getSupabaseAdmin()
    .from("campaigns")
    .select("*")
    .order("created_at", { ascending: false })

  if (!options?.includeArchived) {
    query = query.is("archived_at", null)
  }

  const { data: campaigns, error } = await query
  if (error) throw new Error(`Failed to list campaigns: ${error.message}`)
  if (!campaigns?.length) return []

  const campaignIds = campaigns.map((c) => c.id)
  const { data: leadRows, error: leadError } = await getSupabaseAdmin()
    .from("campaign_leads")
    .select("campaign_id, status")
    .in("campaign_id", campaignIds)

  if (leadError) {
    throw new Error(`Failed to load campaign lead counts: ${leadError.message}`)
  }

  const countsByCampaign = aggregateStatusCounts(
    (leadRows ?? []) as Array<{ campaign_id: string; status: LeadStatus }>,
  )

  return campaigns.map((campaign) => ({
    ...campaign,
    statusCounts: countsByCampaign.get(campaign.id) ?? EMPTY_STATUS_COUNTS(),
  }))
}

export async function getCampaign(id: string): Promise<CampaignRow | null> {
  const { data, error } = await getSupabaseAdmin()
    .from("campaigns")
    .select("*")
    .eq("id", id)
    .maybeSingle()

  if (error) throw new Error(`Failed to load campaign: ${error.message}`)
  return data
}

export async function createCampaign(
  input: CreateCampaignInput,
): Promise<CampaignRow> {
  const parsed = createCampaignSchema.parse(input)
  const slug = await resolveUniqueSlug(parsed.slug)

  const { data, error } = await getSupabaseAdmin()
    .from("campaigns")
    .insert({
      name: parsed.name,
      slug,
      description: parsed.description ?? null,
      landing_template: DEFAULT_LANDING_TEMPLATE,
      merge_layout: SETTING_DEFAULTS["merge.layout"],
      pip_scale: SETTING_DEFAULTS["merge.pip_scale"],
      viewport_width: SETTING_DEFAULTS["recorder.viewport_width"],
      viewport_height: SETTING_DEFAULTS["recorder.viewport_height"],
      nav_timeout_ms: SETTING_DEFAULTS["recorder.nav_timeout_ms"],
    })
    .select("*")
    .single()

  if (error) throw new Error(`Failed to create campaign: ${error.message}`)
  return data
}

export async function updateCampaignGeneral(
  id: string,
  input: UpdateCampaignGeneralInput,
): Promise<CampaignRow> {
  const parsed = updateCampaignGeneralSchema.parse(input)
  const locked = await firstDeployLocked(id)

  if (locked && parsed.slug !== (await getCampaign(id))?.slug) {
    throw new Error("Slug cannot be changed after the first deploy")
  }

  if (!locked && (await slugExists(parsed.slug, id))) {
    throw new Error("Slug is already in use")
  }

  const { data, error } = await getSupabaseAdmin()
    .from("campaigns")
    .update({
      name: parsed.name,
      slug: parsed.slug,
      description: parsed.description ?? null,
    })
    .eq("id", id)
    .select("*")
    .single()

  if (error) throw new Error(`Failed to update campaign: ${error.message}`)
  return data
}

export async function updateCampaignMerge(
  id: string,
  input: UpdateCampaignMergeInput,
): Promise<CampaignRow> {
  const parsed = updateCampaignMergeSchema.parse(input)

  const { data, error } = await getSupabaseAdmin()
    .from("campaigns")
    .update({
      merge_layout: parsed.merge_layout,
      pip_scale: parsed.pip_scale,
      intro_video_id: parsed.intro_video_id,
    })
    .eq("id", id)
    .select("*")
    .single()

  if (error) throw new Error(`Failed to update merge settings: ${error.message}`)
  return data
}

export async function updateCampaignTemplate(
  id: string,
  input: UpdateCampaignTemplateInput,
): Promise<CampaignRow> {
  const parsed = updateCampaignTemplateSchema.parse(input)

  const { data, error } = await getSupabaseAdmin()
    .from("campaigns")
    .update({ landing_template: parsed.landing_template })
    .eq("id", id)
    .select("*")
    .single()

  if (error) throw new Error(`Failed to update template: ${error.message}`)
  return data
}

export async function updateCampaignCta(
  id: string,
  input: UpdateCampaignCtaInput,
): Promise<CampaignRow> {
  const parsed = updateCampaignCtaSchema.parse(input)

  const { data, error } = await getSupabaseAdmin()
    .from("campaigns")
    .update({
      cta_type: parsed.cta_type,
      cta_label: parsed.cta_label,
      cta_url: parsed.cta_url,
    })
    .eq("id", id)
    .select("*")
    .single()

  if (error) throw new Error(`Failed to update CTA: ${error.message}`)
  return data
}

export async function updateCampaignRecorder(
  id: string,
  input: UpdateCampaignRecorderInput,
): Promise<CampaignRow> {
  const parsed = updateCampaignRecorderSchema.parse(input)

  const { data, error } = await getSupabaseAdmin()
    .from("campaigns")
    .update({
      viewport_width: parsed.viewport_width,
      viewport_height: parsed.viewport_height,
      nav_timeout_ms: parsed.nav_timeout_ms,
    })
    .eq("id", id)
    .select("*")
    .single()

  if (error) throw new Error(`Failed to update recorder settings: ${error.message}`)
  return data
}

export async function archiveCampaign(id: string): Promise<CampaignRow> {
  const { data, error } = await getSupabaseAdmin()
    .from("campaigns")
    .update({ archived_at: new Date().toISOString() })
    .eq("id", id)
    .select("*")
    .single()

  if (error) throw new Error(`Failed to archive campaign: ${error.message}`)
  return data
}

export async function unarchiveCampaign(id: string): Promise<CampaignRow> {
  const { data, error } = await getSupabaseAdmin()
    .from("campaigns")
    .update({ archived_at: null })
    .eq("id", id)
    .select("*")
    .single()

  if (error) throw new Error(`Failed to unarchive campaign: ${error.message}`)
  return data
}

export async function deleteCampaign(id: string): Promise<void> {
  const { error } = await getSupabaseAdmin()
    .from("campaigns")
    .delete()
    .eq("id", id)

  if (error) throw new Error(`Failed to delete campaign: ${error.message}`)
}

export async function listIntroVideos(): Promise<IntroVideoOption[]> {
  const { data, error } = await getSupabaseAdmin()
    .from("intro_videos")
    .select("id, name, duration_ms")
    .order("created_at", { ascending: false })

  if (error) throw new Error(`Failed to list intro videos: ${error.message}`)
  return data ?? []
}

/** True when any campaign lead already has a merged video (D11 notice). */
export async function hasBuiltVideos(campaignId: string): Promise<boolean> {
  const { count, error } = await getSupabaseAdmin()
    .from("campaign_leads")
    .select("id", { count: "exact", head: true })
    .eq("campaign_id", campaignId)
    .not("video_id", "is", null)

  if (error) {
    throw new Error(`Failed to check built videos: ${error.message}`)
  }

  return (count ?? 0) > 0
}

/** Most recently updated lead in the campaign, else the synthetic fixture (D19). */
export async function getSampleLeadForCampaign(
  campaignId: string,
): Promise<SampleLead> {
  const { data, error } = await getSupabaseAdmin()
    .from("campaign_leads")
    .select(
      `
      leads (
        id,
        ref,
        first_name,
        last_name,
        full_name,
        company,
        email,
        phone,
        website_url,
        city,
        state,
        country,
        industry,
        updated_at
      )
    `,
    )
    .eq("campaign_id", campaignId)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) {
    throw new Error(`Failed to load sample lead: ${error.message}`)
  }

  const lead = data?.leads as SampleLead | null | undefined
  return lead ?? SAMPLE_LEAD
}
