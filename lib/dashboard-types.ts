import { z } from "zod"

import {
  EMPTY_STATUS_COUNTS,
  LEAD_STATUSES,
  type LeadStatus,
  type LeadStatusCounts,
} from "@/lib/campaign-types"
import type { Database } from "@/lib/database.types"
import { ERROR_BUCKETS, PIPELINE_STEPS } from "@/lib/pipeline-types"

export type PipelineStep = Database["public"]["Enums"]["pipeline_step"]
export type ErrorBucket = Database["public"]["Enums"]["error_bucket"]
export type ErrorCode = Database["public"]["Enums"]["error_code"]

export { ERROR_BUCKETS, PIPELINE_STEPS }

export const BUCKET_ORDER = ERROR_BUCKETS

export type DashboardScope = {
  campaignId: string | null
  includeArchived: boolean
}

export function scopeKey(scope: DashboardScope): string {
  return `${scope.campaignId ?? "all"}:${scope.includeArchived}`
}

export function parseDashboardScope(
  campaignParam: string | undefined,
  archivedParam: string | undefined,
): DashboardScope | { error: string } {
  const includeArchived = archivedParam === "1"

  if (!campaignParam || campaignParam === "all") {
    return { campaignId: null, includeArchived }
  }

  const parsed = z.string().uuid().safeParse(campaignParam)
  if (!parsed.success) {
    return { error: "Invalid campaign id." }
  }

  return { campaignId: parsed.data, includeArchived }
}

const leadStatusSchema = z.enum(LEAD_STATUSES)

const tilesSchema = z
  .record(leadStatusSchema, z.number().int().nonnegative())
  .transform((tiles) => {
    const counts = EMPTY_STATUS_COUNTS()
    for (const status of LEAD_STATUSES) {
      counts[status] = tiles[status] ?? 0
    }
    return counts
  })

const bucketSchema = z.object({
  bucket: z.enum(ERROR_BUCKETS),
  count: z.number().int().nonnegative(),
  error_code: z.string().nullable(),
})

const batchSchema = z.object({
  batch_id: z.string().uuid(),
  ordinal: z.number().int().positive(),
  campaign_id: z.string().uuid(),
  campaign_name: z.string(),
  done: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  paused: z.number().int().nonnegative(),
  remaining: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  oldest_queued_at: z.string().nullable(),
})

const processingRowSchema = z.object({
  id: z.string().uuid(),
  campaign_id: z.string().uuid(),
  campaign_name: z.string(),
  current_step: z.enum(PIPELINE_STEPS),
  attempt_count: z.number().int().nonnegative(),
  name: z.string().nullable(),
  company: z.string().nullable(),
  step_started_at: z.string().nullable(),
})

const pausedCampaignSchema = z.object({
  campaign_id: z.string().uuid(),
  campaign_name: z.string(),
  paused_count: z.number().int().positive(),
  intro_assigned: z.boolean(),
})

export const dashboardCountsSchema = z.object({
  tiles: tilesSchema,
  dry_run_count: z.number().int().nonnegative(),
  buckets: z.array(bucketSchema),
  batches: z.array(batchSchema),
  processing: z.array(processingRowSchema),
  processing_total: z.number().int().nonnegative(),
  paused_campaigns: z.array(pausedCampaignSchema),
  eta_samples: z.array(z.number()),
  has_campaigns: z.boolean(),
  generated_at: z.string(),
})

export type DashboardCountsRaw = z.infer<typeof dashboardCountsSchema>

export type DashboardBatch = DashboardCountsRaw["batches"][number] & {
  etaSeconds: number | null
  etaLabel: string
}

export type DashboardProcessingRow =
  DashboardCountsRaw["processing"][number] & {
    stalledThresholdMs: number | null
  }

export type DashboardSnapshot = {
  scope: DashboardScope
  tiles: LeadStatusCounts
  dryRunCount: number
  buckets: DashboardCountsRaw["buckets"]
  batches: DashboardBatch[]
  batchesTotal: number
  processing: DashboardProcessingRow[]
  processingTotal: number
  pausedCampaigns: DashboardCountsRaw["paused_campaigns"]
  generatedAt: string
  screenState: DashboardScreenState
}

export type DashboardScreenState = "empty" | "idle" | "running" | "all-done"

export function computeScreenState(
  hasCampaigns: boolean,
  tiles: LeadStatusCounts,
): DashboardScreenState {
  if (!hasCampaigns) return "empty"

  const active = tiles.queued + tiles.processing
  if (active > 0) return "running"

  const totalLeads = LEAD_STATUSES.reduce((sum, status) => sum + tiles[status], 0)
  if (totalLeads === 0) return "idle"

  return "all-done"
}

export function computeEtaMean(samples: number[]): number | null {
  if (samples.length < 3) return null
  return samples.reduce((sum, value) => sum + value, 0) / samples.length
}

/** FIFO-by-oldest_queued_at approximates BullMQ ordering — deliberate, no Redis read. */
export function computeBatchEtas(
  batches: DashboardCountsRaw["batches"],
  meanSeconds: number | null,
  concurrency: number,
): DashboardBatch[] {
  const divisor = Math.max(concurrency, 1)
  let prefix = 0

  return batches.map((batch) => {
    prefix += batch.remaining

    if (batch.remaining === 0 && batch.paused > 0) {
      return {
        ...batch,
        etaSeconds: null,
        etaLabel: `${batch.paused} waiting on an intro`,
      }
    }

    if (meanSeconds == null || batch.remaining === 0) {
      return {
        ...batch,
        etaSeconds: null,
        etaLabel: "estimating…",
      }
    }

    const etaSeconds = (meanSeconds * prefix) / divisor
    return {
      ...batch,
      etaSeconds,
      etaLabel: formatEtaDuration(etaSeconds),
    }
  })
}

export function formatEtaDuration(seconds: number): string {
  if (seconds < 60) return "~under a minute"
  if (seconds < 90 * 60) {
    const minutes = Math.max(1, Math.round(seconds / 60))
    return `~${minutes} min`
  }

  const hours = Math.floor(seconds / 3600)
  const minutes = Math.round((seconds % 3600) / 60)
  if (minutes === 0) return `~${hours}h`
  return `~${hours}h ${minutes}m`
}

export function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))}s`
  if (seconds < 3600) {
    const minutes = Math.floor(seconds / 60)
    const remainder = Math.round(seconds % 60)
    return remainder > 0 ? `${minutes}m ${remainder}s` : `${minutes}m`
  }
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.round((seconds % 3600) / 60)
  return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`
}

export type RecorderStallInputs = {
  navTimeoutMs: number
  postLoadDelayMs: number
}

export function deriveRecordingStallThresholdMs(
  inputs: RecorderStallInputs,
): number {
  const navTimeoutMs = inputs.navTimeoutMs
  const cookieDismissCapMs = 2_000
  const postLoadDelayMs = inputs.postLoadDelayMs
  const scrollClampCeilingMs = 90_000
  const transcodeAllowanceMs = 60_000
  return (
    (navTimeoutMs +
      cookieDismissCapMs +
      postLoadDelayMs +
      scrollClampCeilingMs +
      transcodeAllowanceMs) *
    1.5
  )
}

export function deriveStepStallThresholdMs(
  step: PipelineStep,
  settings: {
    navTimeoutMs: number
    postLoadDelayMs: number
    mergeTimeoutMs: number
    deployTimeoutMs: number
  },
): number {
  switch (step) {
    case "recording":
      return deriveRecordingStallThresholdMs({
        navTimeoutMs: settings.navTimeoutMs,
        postLoadDelayMs: settings.postLoadDelayMs,
      })
    case "merge":
      return settings.mergeTimeoutMs + 30_000
    case "deploy":
      return settings.deployTimeoutMs + 30_000
    case "page":
      // Phase 12 plan — no page.timeout_ms setting exists.
      return 120_000
  }
}

export function isProcessingStalled(
  stepStartedAt: string | null,
  thresholdMs: number,
  nowMs: number = Date.now(),
): boolean {
  if (!stepStartedAt) return false
  const startedMs = Date.parse(stepStartedAt)
  if (Number.isNaN(startedMs)) return false
  return nowMs - startedMs > thresholdMs
}

export const STATUS_TILE_ORDER: readonly LeadStatus[] = [
  "queued",
  "processing",
  "paused",
  "deployed",
  "ready",
  "failed",
  "skipped",
]

export const STATUS_TILE_LABELS: Record<LeadStatus, string> = {
  queued: "Queued",
  processing: "Processing",
  paused: "Paused",
  deployed: "Deployed",
  ready: "Ready",
  failed: "Failed",
  skipped: "Skipped",
}

export const BUCKET_LABELS: Record<ErrorBucket, string> = {
  bad_website: "Bad Website",
  blocked: "Blocked",
  system: "System",
}

export const STEP_LABELS: Record<PipelineStep, string> = {
  recording: "Recording",
  merge: "Merge",
  page: "Page",
  deploy: "Deploy",
}

export function leadsFilterHref(options: {
  campaignId?: string | null
  status?: LeadStatus
  bucket?: ErrorBucket
  includeArchived?: boolean
}): string {
  const params = new URLSearchParams()
  if (options.campaignId) params.set("campaign", options.campaignId)
  if (options.status) params.set("status", options.status)
  if (options.bucket) params.set("bucket", options.bucket)
  if (options.includeArchived) params.set("archived", "1")
  const query = params.toString()
  return query ? `/leads?${query}` : "/leads"
}
