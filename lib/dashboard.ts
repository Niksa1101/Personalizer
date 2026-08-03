import "server-only"

import {
  computeBatchEtas,
  computeEtaMean,
  computeScreenState,
  dashboardCountsSchema,
  deriveStepStallThresholdMs,
  scopeKey,
  type DashboardScope,
  type DashboardSnapshot,
} from "@/lib/dashboard-types"
import { resolveMany, resolveValue } from "@/lib/settings"
import { getSupabaseAdmin } from "@/lib/supabase"

const PROCESSING_CAP = 10
const BATCH_CAP = 3

const validationLogAt = new Map<string, number>()
const VALIDATION_LOG_MS = 60_000

export async function getDashboardSnapshot(
  scope: DashboardScope,
): Promise<DashboardSnapshot> {
  const supabase = getSupabaseAdmin()
  const { data, error } = await supabase.rpc("dashboard_counts", {
    p_campaign_id: scope.campaignId ?? undefined,
    p_include_archived: scope.includeArchived,
  })

  if (error) {
    throw new Error(`Failed to load dashboard snapshot: ${error.message}`)
  }

  const parsed = dashboardCountsSchema.safeParse(data)
  if (!parsed.success) {
    const logKey = scopeKey(scope)
    const now = Date.now()
    const lastLogged = validationLogAt.get(logKey) ?? 0
    if (now - lastLogged >= VALIDATION_LOG_MS) {
      validationLogAt.set(logKey, now)
      const { error: logError } = await supabase.from("logs").insert({
        level: "error",
        scope: "web",
        message: "Dashboard snapshot validation failed",
        meta: {
          scope,
          error: parsed.error.message,
        },
      })
      if (logError) {
        console.error("Failed to write dashboard validation log:", logError.message)
      }
    }
    throw new Error("Dashboard snapshot validation failed")
  }

  const raw = parsed.data
  const globalDefaults = await resolveMany([
    "queue.concurrency",
    "recorder.post_load_delay_ms",
    "encode.merge_timeout_ms",
    "deploy.timeout_ms",
  ])
  const concurrency = globalDefaults["queue.concurrency"]

  const cappedProcessing = raw.processing.slice(0, PROCESSING_CAP)
  const campaignIds = [
    ...new Set(cappedProcessing.map((row) => row.campaign_id)),
  ]

  const campaignSettings = new Map<
    string,
    {
      navTimeoutMs: number
      postLoadDelayMs: number
      mergeTimeoutMs: number
      deployTimeoutMs: number
    }
  >()

  if (campaignIds.length > 0) {
    const { data: campaigns, error: campaignError } = await supabase
      .from("campaigns")
      .select("id, nav_timeout_ms")
      .in("id", campaignIds)

    if (campaignError) {
      throw new Error(
        `Failed to load campaign recorder settings: ${campaignError.message}`,
      )
    }

    for (const campaign of campaigns ?? []) {
      campaignSettings.set(campaign.id, {
        navTimeoutMs: resolveValue(
          "recorder.nav_timeout_ms",
          globalDefaults,
          { campaign: campaign.nav_timeout_ms },
        ),
        postLoadDelayMs: globalDefaults["recorder.post_load_delay_ms"],
        mergeTimeoutMs: globalDefaults["encode.merge_timeout_ms"],
        deployTimeoutMs: globalDefaults["deploy.timeout_ms"],
      })
    }
  }

  const meanSeconds = computeEtaMean(raw.eta_samples)
  const batchesWithEta = computeBatchEtas(raw.batches, meanSeconds, concurrency)

  const processing = cappedProcessing.map((row) => {
    const settings = campaignSettings.get(row.campaign_id)
    const thresholdMs = settings
      ? deriveStepStallThresholdMs(row.current_step, settings)
      : null

    return {
      ...row,
      stalledThresholdMs: thresholdMs,
    }
  })

  return {
    scope,
    tiles: raw.tiles,
    dryRunCount: raw.dry_run_count,
    buckets: raw.buckets,
    batches: batchesWithEta.slice(0, BATCH_CAP),
    batchesTotal: batchesWithEta.length,
    processing,
    processingTotal: raw.processing_total,
    pausedCampaigns: raw.paused_campaigns,
    generatedAt: raw.generated_at,
    screenState: computeScreenState(raw.has_campaigns, raw.tiles),
  }
}

export {
  parseDashboardScope,
  scopeKey,
  type DashboardScope,
  type DashboardSnapshot,
} from "@/lib/dashboard-types"
