import { z } from "zod"

import type { Database } from "@/lib/database.types"

export type ImportBatchRow = Database["public"]["Tables"]["import_batches"]["Row"]

/** Mapped lead fields produced by the CSV importer. */
export const IMPORT_FIELDS = [
  "website_url",
  "email",
  "company",
  "first_name",
  "last_name",
  "full_name",
  "phone",
  "city",
  "state",
  "country",
  "industry",
] as const

export type ImportField = (typeof IMPORT_FIELDS)[number]

export const UNMAPPED = "unmapped" as const

export type HeaderMapping = Record<string, ImportField | typeof UNMAPPED>

/** Normalize a CSV header for alias lookup. */
export function normalizeHeader(header: string): string {
  return header
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "")
}

/**
 * Alias table — order within each field is precedence for D18 collisions.
 * First matching alias wins when two columns map to the same field.
 */
export const FIELD_ALIASES: Record<ImportField, readonly string[]> = {
  website_url: ["website", "websiteurl", "url", "domain", "site", "homepage"],
  company: ["company", "business", "companyname", "organization"],
  email: ["email", "e-mail", "emailaddress"],
  first_name: ["firstname", "givenname", "fname"],
  last_name: ["lastname", "surname", "lname"],
  full_name: ["fullname", "contact", "owner", "name"],
  phone: ["phone", "telephone", "tel", "mobile", "cell"],
  city: ["city", "town"],
  state: ["state", "province", "region"],
  country: ["country", "nation"],
  industry: ["industry", "category", "sector", "niche"],
}

/** Social profile hosts — suffix match on registrable host (D23). */
export const SOCIAL_HOSTS = [
  "facebook.com",
  "instagram.com",
  "linkedin.com",
  "twitter.com",
  "x.com",
  "tiktok.com",
  "youtube.com",
] as const

/** Directory / listing hosts — suffix match, plus path-aware entries. */
export const DIRECTORY_HOSTS = [
  "yelp.com",
  "maps.google.com",
  "g.page",
  "business.google.com",
  "yellowpages.com",
  "bbb.org",
  "tripadvisor.com",
  "foursquare.com",
  "angi.com",
  "thumbtack.com",
  "nextdoor.com",
  "mapquest.com",
  "manta.com",
  "houzz.com",
] as const

/** Path-aware directory patterns: host + path prefix. */
export const DIRECTORY_PATH_PATTERNS = ["google.com/maps"] as const

export type SkipReason = "not_a_website"

export type ParsedImportRow = {
  website_url: string | null
  email: string | null
  company: string | null
  first_name: string | null
  last_name: string | null
  full_name: string | null
  phone: string | null
  city: string | null
  state: string | null
  country: string | null
  industry: string | null
  raw: Record<string, string>
  skip: SkipReason | null
}

export type RejectedRow = {
  row: number
  reason: string
}

export type ImportCounts = {
  imported: number
  linked: number
  duplicate: number
  skipped: number
  rejected: number
}

export type ExistsListEntry = {
  company: string | null
  domain: string | null
  email: string | null
  campaigns: Array<{ id: string; name: string }>
}

export type PreviewResult = {
  token: string
  delimiter: string
  hadBom: boolean
  mapping: HeaderMapping
  headers: string[]
  sampleRows: ParsedImportRow[]
  counts: ImportCounts
  existsList: ExistsListEntry[]
  rejectedRows: RejectedRow[]
  rowCount: number
}

export type CommitReport = ImportBatchRow

export const refreshPreviewSchema = z.object({
  token: z.string().min(1),
  campaignId: z.string().uuid(),
  mapping: z.record(z.string(), z.enum([...IMPORT_FIELDS, UNMAPPED])),
})

export type RefreshPreviewInput = z.infer<typeof refreshPreviewSchema>

export const commitImportSchema = z.object({
  token: z.string().min(1),
  campaignId: z.string().uuid(),
  filename: z.string().min(1),
  mapping: z.record(z.string(), z.enum([...IMPORT_FIELDS, UNMAPPED])),
})

export type CommitImportInput = z.infer<typeof commitImportSchema>

export type ImportCommitRpcResult = {
  batch_id?: string
  counts: {
    imported: number
    linked: number
    duplicate: number
    skipped: number
  }
  exists_list: ExistsListEntry[]
  created_campaign_lead_ids?: string[]
  per_row_outcomes?: Array<{ outcome: string }>
}
