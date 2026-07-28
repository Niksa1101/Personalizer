import { z } from "zod"

import { MERGE_LAYOUTS } from "@/lib/campaign-types"

function emptyToNull(value: unknown): string | null {
  if (value == null) return null
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return trimmed === "" ? null : trimmed
}

const nullableText = z.preprocess(emptyToNull, z.string().max(240).nullable())

export const leadEditSchema = z
  .object({
    first_name: nullableText,
    last_name: nullableText,
    full_name: nullableText,
    company: nullableText,
    email: z.preprocess(
      emptyToNull,
      z
        .string()
        .email("Invalid email")
        .max(320)
        .nullable(),
    ),
    phone: z.preprocess(emptyToNull, z.string().max(60).nullable()),
    website_url: z.preprocess(emptyToNull, z.string().max(2048).nullable()),
    city: z.preprocess(emptyToNull, z.string().max(120).nullable()),
    state: z.preprocess(emptyToNull, z.string().max(120).nullable()),
    country: z.preprocess(emptyToNull, z.string().max(120).nullable()),
    merge_layout: z.preprocess(
      (value) => (value === "" ? null : value),
      z.enum(MERGE_LAYOUTS).nullable(),
    ),
    pip_scale: z.preprocess(
      (value) => {
        if (value === null || value === "" || value === undefined) return null
        const parsed =
          typeof value === "number" ? value : Number(String(value).trim())
        return Number.isFinite(parsed) ? parsed : value
      },
      z.number().min(0.05).max(0.6).nullable(),
    ),
    leads_updated_at: z.string(),
  })

export type LeadEditInput = z.infer<typeof leadEditSchema>
