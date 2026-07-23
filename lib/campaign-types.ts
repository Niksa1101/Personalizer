import { z } from "zod"

import type { Database } from "@/lib/database.types"
import { SLUG_REGEX } from "@/lib/slug"

export type CampaignRow = Database["public"]["Tables"]["campaigns"]["Row"]
export type LeadStatus = Database["public"]["Enums"]["lead_status"]
export type MergeLayout = Database["public"]["Enums"]["merge_layout"]

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

export const LEAD_STATUSES = [
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
