import "server-only"

import { LEAD_STATUSES, type LeadStatus } from "@/lib/campaign-types"
import { toCsv } from "@/lib/csv"
import type { Database } from "@/lib/database.types"
import { getSupabaseAdmin, type PostgrestFilterable } from "@/lib/supabase"

export type ExportViewRow =
  Database["public"]["Views"]["v_exportable_leads"]["Row"]

export type ExportParams = {
  campaignId?: string
  statuses: LeadStatus[]
}

export const EXPORT_COLUMNS = [
  { header: "ref", key: "lead_ref" },
  { header: "first_name", key: "first_name" },
  { header: "last_name", key: "last_name" },
  { header: "full_name", key: "full_name" },
  { header: "company", key: "company" },
  { header: "email", key: "email" },
  { header: "phone", key: "phone" },
  { header: "website_url", key: "website_url" },
  { header: "city", key: "city" },
  { header: "state", key: "state" },
  { header: "country", key: "country" },
  { header: "industry", key: "industry" },
  { header: "campaign", key: "campaign_name" },
  { header: "campaign_ref", key: "campaign_ref" },
  { header: "landing_url", key: "landing_url" },
  { header: "video_url", key: "video_url" },
  { header: "status", key: "status" },
  { header: "deployed_at", key: "deployed_at" },
  { header: "promoted_at", key: "promoted_at" },
] as const satisfies ReadonlyArray<{
  header: string
  key: keyof ExportViewRow
}>

const EXPORT_HEADERS = EXPORT_COLUMNS.map((col) => col.header)

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const PAGE_SIZE = 500

function applyExportFilters<T extends object>(q: T, params: ExportParams): T {
  let query = q as unknown as PostgrestFilterable
  if (params.campaignId) {
    query = query.eq("campaign_id", params.campaignId)
  } else {
    query = query.eq("campaign_archived", false)
  }
  return query.in("status", params.statuses) as unknown as T
}

export function parseExportParams(
  searchParams: URLSearchParams,
): ExportParams | { error: string } {
  const campaignRaw = searchParams.get("campaign")
  if (campaignRaw && !UUID_RE.test(campaignRaw)) {
    return { error: "Invalid campaign id" }
  }

  const statusValues: string[] = []
  for (const value of searchParams.getAll("status")) {
    for (const part of value.split(",")) {
      const trimmed = part.trim()
      if (trimmed && !statusValues.includes(trimmed)) statusValues.push(trimmed)
    }
  }

  const statuses =
    statusValues.length > 0 ? statusValues : (["ready"] as string[])

  const invalid = statuses.filter(
    (s) => !(LEAD_STATUSES as readonly string[]).includes(s),
  )
  if (invalid.length > 0) {
    return {
      error: `Invalid status value(s): ${invalid.join(", ")}. Valid: ${LEAD_STATUSES.join(", ")}`,
    }
  }

  return {
    campaignId: campaignRaw ?? undefined,
    statuses: statuses as LeadStatus[],
  }
}

export function buildExportFilename(
  campaignRef: string | null,
  statuses: LeadStatus[],
  now: Date,
): string {
  const campaignToken = campaignRef ?? "all"
  let statusToken: string
  if (statuses.length === 1) {
    statusToken = statuses[0]!
  } else if (statuses.length === 2) {
    statusToken = statuses.join("+")
  } else {
    statusToken = "multi"
  }

  const y = now.getUTCFullYear()
  const mo = String(now.getUTCMonth() + 1).padStart(2, "0")
  const d = String(now.getUTCDate()).padStart(2, "0")
  const h = String(now.getUTCHours()).padStart(2, "0")
  const mi = String(now.getUTCMinutes()).padStart(2, "0")

  return `personalizer-${campaignToken}-${statusToken}-${y}${mo}${d}-${h}${mi}.csv`
}

export function formatIsoSeconds(value: string | null): string | null {
  if (value == null) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  const iso = date.toISOString()
  return iso.replace(/\.\d{3}Z$/, "Z")
}

export async function countExportRows(
  params: ExportParams,
): Promise<{ exportable: number; excluded: number }> {
  const supabase = getSupabaseAdmin()

  const exportableQuery = applyExportFilters(
    supabase.from("v_exportable_leads").select("*", { count: "exact", head: true }),
    params,
  ).eq("is_page_removed", false)

  const excludedQuery = applyExportFilters(
    supabase.from("v_exportable_leads").select("*", { count: "exact", head: true }),
    params,
  ).eq("is_page_removed", true)

  const [exportableResult, excludedResult] = await Promise.all([
    exportableQuery,
    excludedQuery,
  ])

  if (exportableResult.error) {
    throw new Error(`Export count failed: ${exportableResult.error.message}`)
  }
  if (excludedResult.error) {
    throw new Error(`Export exclusion count failed: ${excludedResult.error.message}`)
  }

  return {
    exportable: exportableResult.count ?? 0,
    excluded: excludedResult.count ?? 0,
  }
}

function rowToCsvCells(row: ExportViewRow): (string | null)[] {
  return EXPORT_COLUMNS.map((col) => {
    const raw = row[col.key]
    if (col.key === "deployed_at" || col.key === "promoted_at") {
      return formatIsoSeconds(raw as string | null)
    }
    if (raw == null) return null
    return String(raw)
  })
}

async function countExcludedRows(params: ExportParams): Promise<number> {
  const { count, error } = await applyExportFilters(
    getSupabaseAdmin()
      .from("v_exportable_leads")
      .select("*", { count: "exact", head: true }),
    params,
  ).eq("is_page_removed", true)
  if (error) throw new Error(`Export exclusion count failed: ${error.message}`)
  return count ?? 0
}

export async function fetchExportRows(params: ExportParams): Promise<{
  rows: ExportViewRow[]
  skipped: number
  missingVideo: number
}> {
  const supabase = getSupabaseAdmin()
  const excluded = await countExcludedRows(params)

  const allRows: ExportViewRow[] = []
  let from = 0

  while (true) {
    const to = from + PAGE_SIZE - 1
    const { data, error } = await applyExportFilters(
      supabase.from("v_exportable_leads").select("*"),
      params,
    )
      .eq("is_page_removed", false)
      .order("campaign_ref")
      .order("lead_ref")
      .range(from, to)

    if (error) throw new Error(`Export fetch failed: ${error.message}`)

    const page = (data ?? []) as ExportViewRow[]
    allRows.push(...page)
    if (page.length < PAGE_SIZE) break
    from += PAGE_SIZE
  }

  const missingVideo = allRows.filter((row) => !row.video_url).length

  return { rows: allRows, skipped: excluded, missingVideo }
}

export function buildExportCsv(rows: ExportViewRow[]): string {
  const csvRows = rows.map((row) => rowToCsvCells(row))
  return toCsv(EXPORT_HEADERS, csvRows)
}

export async function resolveExportCampaignRef(
  campaignId: string | undefined,
): Promise<string | null> {
  if (!campaignId) return null
  const { data, error } = await getSupabaseAdmin()
    .from("campaigns")
    .select("ref")
    .eq("id", campaignId)
    .maybeSingle()
  if (error) throw new Error(`Failed to resolve campaign ref: ${error.message}`)
  return data?.ref ?? null
}
