import "server-only"

import { z } from "zod"

import type { Database } from "@/lib/database.types"
import {
  DEFAULT_LANDING_TEMPLATE,
  SAMPLE_LEAD,
  type SampleLead,
} from "@/lib/landing-template"
import { SETTING_DEFAULTS } from "@/lib/settings"
import { getSupabaseAdmin } from "@/lib/supabase"

export type CampaignRow = Database["public"]["Tables"]["campaigns"]["Row"]
export type LeadStatus = Database["public"]["Enums"]["lead_status"]
export type MergeLayout = Database["public"]["Enums"]["merge_layout"]

export const SLUG_REGEX = /^[a-z0-9]+(-[a-z0-9]+)*$/

export const MERGE_LAYOUTS = [
  "bubble_br",
  "bubble_bl",
  "bubble_tr",
  "bubble_tl",
  "rect_br",
  "fullscreen_intro",
] as const satisfies readonly MergeLayout[]

export const CTA_TYPES = [
  "calendar",
  "website",
  "email",
  "phone",
  "custom",
] as const

export type CtaType = (typeof CTA_TYPES)[number]

export const VIEWPORT_PRESETS = [
  { label: "Desktop 1080p", width: 1920, height: 1080 },
  { label: "1536×864", width: 1536, height: 864 },
  { label: "1440×900", width: 1440, height: 900 },
  { label: "1366×768", width: 1366, height: 768 },
  { label: "1440p", width: 2560, height: 1440 },
] as const

export type LeadStatusCounts = Record<LeadStatus, number>

export const EMPTY_STATUS_COUNTS = (): LeadStatusCounts => ({
  queued: 0,
  processing: 0,
  paused: 0,
  deployed: 0,
  ready: 0,
  failed: 0,
  skipped: 0,
})

export type CampaignListItem = CampaignRow & {
  statusCounts: LeadStatusCounts
}

export type IntroVideoOption = Pick<
  Database["public"]["Tables"]["intro_videos"]["Row"],
  "id" | "name" | "duration_ms"
>

const LEAD_STATUSES = [
  "queued",
  "processing",
  "paused",
  "deployed",
  "ready",
  "failed",
  "skipped",
] as const satisfies readonly LeadStatus[]

export const createCampaignSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(120),
  slug: z
    .string()
    .trim()
    .regex(SLUG_REGEX, "Slug must be lowercase letters, numbers, and hyphens"),
  description: z.string().trim().max(2000).optional().nullable(),
})

export const updateCampaignGeneralSchema = createCampaignSchema

export const updateCampaignMergeSchema = z.object({
  merge_layout: z.enum(MERGE_LAYOUTS),
  pip_scale: z.coerce.number().min(0.05).max(0.6),
  intro_video_id: z.string().uuid().nullable(),
})

export const updateCampaignTemplateSchema = z.object({
  landing_template: z.string().trim().min(1, "Template cannot be empty"),
})

export const updateCampaignCtaSchema = z
  .object({
    cta_type: z.enum(CTA_TYPES).nullable(),
    cta_label: z.string().trim().max(120).nullable(),
    cta_url: z.string().trim().max(2048).nullable(),
  })
  .superRefine((data, ctx) => {
    const hasType = data.cta_type != null
    const hasLabel = Boolean(data.cta_label?.trim())
    const hasUrl = Boolean(data.cta_url?.trim())

    if (!hasType && !hasLabel && !hasUrl) return

    if (hasType !== hasLabel || hasType !== hasUrl) {
      ctx.addIssue({
        code: "custom",
        message: "CTA type, label, and URL must all be set together or left empty",
        path: ["cta_type"],
      })
      return
    }

    if (!data.cta_type || !data.cta_url) return

    switch (data.cta_type) {
      case "email": {
        if (
          !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.cta_url) &&
          !data.cta_url.startsWith("mailto:")
        ) {
          ctx.addIssue({
            code: "custom",
            message: "Enter a valid email address or mailto: URL",
            path: ["cta_url"],
          })
        }
        break
      }
      case "phone": {
        if (
          !/^[\d\s().+\-]+$/.test(data.cta_url) &&
          !data.cta_url.startsWith("tel:")
        ) {
          ctx.addIssue({
            code: "custom",
            message: "Enter a valid phone number or tel: URL",
            path: ["cta_url"],
          })
        }
        break
      }
      case "website":
      case "calendar": {
        try {
          new URL(data.cta_url)
        } catch {
          ctx.addIssue({
            code: "custom",
            message: "Enter a valid URL",
            path: ["cta_url"],
          })
        }
        break
      }
      case "custom":
        break
    }
  })

export const updateCampaignRecorderSchema = z.object({
  viewport_width: z.coerce.number().int().positive(),
  viewport_height: z.coerce.number().int().positive(),
  nav_timeout_ms: z.coerce.number().int().min(10_000).max(600_000),
})

export type CreateCampaignInput = z.infer<typeof createCampaignSchema>
export type UpdateCampaignGeneralInput = z.infer<
  typeof updateCampaignGeneralSchema
>
export type UpdateCampaignMergeInput = z.infer<typeof updateCampaignMergeSchema>
export type UpdateCampaignTemplateInput = z.infer<
  typeof updateCampaignTemplateSchema
>
export type UpdateCampaignCtaInput = z.infer<typeof updateCampaignCtaSchema>
export type UpdateCampaignRecorderInput = z.infer<
  typeof updateCampaignRecorderSchema
>

/** Tech.md §10.1 — lowercase, non-alphanumerics → hyphen, collapse, trim. */
export function slugFromName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
}

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

export { LEAD_STATUSES }
