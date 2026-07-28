import { ERROR_BUCKETS } from "@/lib/pipeline-types"
import { LEAD_STATUSES, type LeadStatus } from "@/lib/campaign-types"
import type { ErrorBucket } from "@/lib/pipeline-types"
import type { PipelineStep } from "@/lib/pipeline-types"

export const LEADS_PAGE_SIZE = 50

export type LeadSortColumn =
  | "ref"
  | "company"
  | "website"
  | "city"
  | "campaign"
  | "status"
  | "landing_url"
  | "updated_at"

export const LEAD_SORT_COLUMNS: readonly LeadSortColumn[] = [
  "ref",
  "company",
  "website",
  "city",
  "campaign",
  "status",
  "landing_url",
  "updated_at",
] as const

export type LeadFilters = {
  campaignId?: string
  status?: LeadStatus
  bucket?: ErrorBucket
  batchId?: string
  search?: string
  includeArchived: boolean
  page: number
  sort: LeadSortColumn
  order: "asc" | "desc"
  leadId?: string
}

export type LeadsSearchParams = Record<string, string | string[] | undefined>

function firstParam(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0]
  return value
}

/** Escape ilike metacharacters so they match literally. */
export function escapeIlikePattern(input: string): string {
  return input.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_")
}

/**
 * Quote a PostgREST filter value. Quoting — not backslash-escaping — is what
 * makes `,` `(` `)` `.` safe inside `or=(...)`. PostgREST unescapes
 * backslashes inside a quoted value, so every backslash the ilike layer added
 * must be doubled here, and `"` escaped.
 */
export function quotePostgrestValue(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
}

export function buildLeadSearchOrFilter(search: string): string {
  const pattern = quotePostgrestValue(
    `%${escapeIlikePattern(search.trim())}%`,
  )
  return ["company", "full_name", "website_url", "domain", "ref"]
    .map((field) => `${field}.ilike.${pattern}`)
    .join(",")
}

export function parseLeadFilters(
  params: LeadsSearchParams,
): LeadFilters {
  const campaignId = firstParam(params.campaign)
  const statusRaw = firstParam(params.status)
  const bucketRaw = firstParam(params.bucket)
  const batchId = firstParam(params.batch)
  const search = firstParam(params.q)?.trim() || undefined
  const includeArchived = firstParam(params.archived) === "1"
  const leadId = firstParam(params.lead)

  const pageRaw = Number(firstParam(params.page) ?? "1")
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : 1

  const sortRaw = firstParam(params.sort) as LeadSortColumn | undefined
  const sort = LEAD_SORT_COLUMNS.includes(sortRaw as LeadSortColumn)
    ? (sortRaw as LeadSortColumn)
    : "updated_at"

  const orderRaw = firstParam(params.order)
  const order = orderRaw === "asc" ? "asc" : "desc"

  const status =
    statusRaw && (LEAD_STATUSES as readonly string[]).includes(statusRaw)
      ? (statusRaw as LeadStatus)
      : undefined

  const bucket =
    bucketRaw && (ERROR_BUCKETS as readonly string[]).includes(bucketRaw)
      ? (bucketRaw as ErrorBucket)
      : undefined

  return {
    campaignId,
    status,
    bucket,
    batchId,
    search,
    includeArchived,
    page,
    sort,
    order,
    leadId,
  }
}

export function serializeLeadFilters(
  filters: LeadFilters,
  overrides?: Partial<LeadFilters>,
): URLSearchParams {
  const merged = { ...filters, ...overrides }
  const params = new URLSearchParams()

  if (merged.campaignId) params.set("campaign", merged.campaignId)
  if (merged.status) params.set("status", merged.status)
  if (merged.bucket) params.set("bucket", merged.bucket)
  if (merged.batchId) params.set("batch", merged.batchId)
  if (merged.search) params.set("q", merged.search)
  if (merged.includeArchived) params.set("archived", "1")
  if (merged.page > 1) params.set("page", String(merged.page))
  if (merged.sort !== "updated_at") params.set("sort", merged.sort)
  if (merged.order !== "desc") params.set("order", merged.order)
  if (merged.leadId) params.set("lead", merged.leadId)

  return params
}

export function leadsPageHref(
  filters: LeadFilters,
  overrides?: Partial<LeadFilters>,
): string {
  const params = serializeLeadFilters(filters, overrides)
  const query = params.toString()
  return query ? `/leads?${query}` : "/leads"
}

export type LeadStreamScope = {
  campaignId: string | null
  includeArchived: boolean
}

export function leadStreamScopeKey(scope: LeadStreamScope): string {
  return `${scope.campaignId ?? "all"}:${scope.includeArchived ? "1" : "0"}`
}

export function parseLeadStreamScope(
  campaign?: string,
  archived?: string,
): LeadStreamScope | { error: string } {
  if (
    campaign &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      campaign,
    )
  ) {
    return { error: "Invalid campaign id" }
  }
  return {
    campaignId: campaign ?? null,
    includeArchived: archived === "1",
  }
}

export const TERMINAL_STATUSES: readonly LeadStatus[] = ["ready", "skipped"]

export function displayCurrentStep(
  status: LeadStatus,
  step: PipelineStep,
): PipelineStep | null {
  if (TERMINAL_STATUSES.includes(status)) return null
  return step
}
