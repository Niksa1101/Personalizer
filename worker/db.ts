import type { Database } from "@/lib/database.types"
import type { SampleLead } from "@/lib/landing-template"
import type {
  ErrorCode,
  EventKind,
  PipelineEventMeta,
  PipelineStep,
} from "@/lib/pipeline-types"
import { getSupabaseAdmin } from "@/lib/supabase"

type CampaignLeadRow = Database["public"]["Tables"]["campaign_leads"]["Row"]
type JobRunRow = Database["public"]["Tables"]["job_runs"]["Row"]
type LandingPageRow = Database["public"]["Tables"]["landing_pages"]["Row"]
type VideoRow = Database["public"]["Tables"]["videos"]["Row"]

export type LeadContext = {
  campaignLead: CampaignLeadRow
  campaign: {
    id: string
    slug: string
    intro_video_id: string | null
    merge_layout: Database["public"]["Enums"]["merge_layout"]
    pip_scale: number
    viewport_width: number
    viewport_height: number
    nav_timeout_ms: number
  }
  lead: {
    id: string
    domain: string | null
    website_url: string | null
    source_batch_id: string | null
    company: string | null
    full_name: string | null
    city: string | null
  }
  hasUsableRecording: boolean
}

export type JobSettings = {
  autoRetryLimit: number
}

export type LeadBase = {
  campaignLead: CampaignLeadRow
  campaign: LeadContext["campaign"]
  lead: LeadContext["lead"]
}

export type RecorderContext = LeadContext

export type PageContext = {
  campaignLead: Pick<CampaignLeadRow, "id" | "slug" | "landing_page_id">
  campaign: {
    slug: string
    landing_template: string
    cta_type: string | null
    cta_label: string | null
    cta_url: string | null
  }
  lead: SampleLead
  video: Pick<VideoRow, "web_public_url" | "poster_storage_key"> | null
  existingLandingPage: Pick<
    LandingPageRow,
    "id" | "content_sha1" | "deploy_status" | "path" | "unpublished_at"
  > | null
}

export type UsableRecording = {
  id: string
  local_path: string | null
  purged_at: string | null
  duration_ms: number | null
}

export type LogScope =
  | "importer"
  | "recorder"
  | "merger"
  | "deployer"
  | "web"
  | "worker"

export type ClaimResult = "claimed" | "skipped" | "gone"

const SCAN_LIMIT = 500

export async function loadLeadBase(
  campaignLeadId: string,
): Promise<LeadBase | null> {
  const { data: campaignLead, error } = await getSupabaseAdmin()
    .from("campaign_leads")
    .select("*")
    .eq("id", campaignLeadId)
    .maybeSingle()

  if (error) {
    throw new Error(`Failed to load campaign lead: ${error.message}`)
  }
  if (!campaignLead) return null

  const [{ data: campaign, error: campaignError }, { data: lead, error: leadError }] =
    await Promise.all([
      getSupabaseAdmin()
        .from("campaigns")
        .select(
          "id, slug, intro_video_id, merge_layout, pip_scale, viewport_width, viewport_height, nav_timeout_ms",
        )
        .eq("id", campaignLead.campaign_id)
        .maybeSingle(),
      getSupabaseAdmin()
        .from("leads")
        .select(
          "id, domain, website_url, source_batch_id, company, full_name, city",
        )
        .eq("id", campaignLead.lead_id)
        .maybeSingle(),
    ])

  if (campaignError) {
    throw new Error(`Failed to load campaign: ${campaignError.message}`)
  }
  if (leadError) {
    throw new Error(`Failed to load lead: ${leadError.message}`)
  }
  if (!campaign || !lead) {
    throw new Error(`Campaign lead ${campaignLeadId} is missing campaign or lead`)
  }

  return { campaignLead, campaign, lead }
}

export async function loadRecorderContext(
  campaignLeadId: string,
): Promise<RecorderContext | null> {
  const base = await loadLeadBase(campaignLeadId)
  if (!base) return null

  const hasUsableRecording = await checkUsableRecording(base.lead.id)
  return { ...base, hasUsableRecording }
}

export async function getUsableRecording(
  leadId: string,
): Promise<UsableRecording | null> {
  const { data, error } = await getSupabaseAdmin()
    .from("recordings")
    .select("id, local_path, purged_at, duration_ms")
    .eq("lead_id", leadId)
    .is("error_code", null)
    .is("purged_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) {
    throw new Error(`Failed to load usable recording: ${error.message}`)
  }

  return data
}

export async function insertRecording(input: {
  leadId: string
  localPath: string
  durationMs: number
  width: number
  height: number
  pageHeightPx: number
  fileSizeBytes: number
  screenshotBeforePath: string | null
  screenshotAfterPath: string | null
}): Promise<string> {
  const { data, error } = await getSupabaseAdmin()
    .from("recordings")
    .insert({
      lead_id: input.leadId,
      local_path: input.localPath,
      duration_ms: input.durationMs,
      width: input.width,
      height: input.height,
      page_height_px: input.pageHeightPx,
      file_size_bytes: input.fileSizeBytes,
      screenshot_before_path: input.screenshotBeforePath,
      screenshot_after_path: input.screenshotAfterPath,
      recorded_at: new Date().toISOString(),
    })
    .select("id")
    .single()

  if (error) {
    throw new Error(`Failed to insert recording: ${error.message}`)
  }

  return data.id
}

/**
 * Refresh an existing recording row in place with a fresh capture. Used for
 * forced re-records: updating the single active row (rather than purge + insert)
 * avoids both the two-active `recordings_lead_active_uk` conflict and the window
 * where a failed insert would leave the lead with no usable recording.
 */
export async function updateRecordingCapture(
  recordingId: string,
  input: {
    localPath: string
    durationMs: number
    width: number
    height: number
    pageHeightPx: number
    fileSizeBytes: number
    screenshotBeforePath: string | null
    screenshotAfterPath: string | null
  },
): Promise<void> {
  const { error } = await getSupabaseAdmin()
    .from("recordings")
    .update({
      local_path: input.localPath,
      duration_ms: input.durationMs,
      width: input.width,
      height: input.height,
      page_height_px: input.pageHeightPx,
      file_size_bytes: input.fileSizeBytes,
      screenshot_before_path: input.screenshotBeforePath,
      screenshot_after_path: input.screenshotAfterPath,
      recorded_at: new Date().toISOString(),
      purged_at: null,
      error_code: null,
    })
    .eq("id", recordingId)

  if (error) {
    throw new Error(`Failed to update recording: ${error.message}`)
  }
}

export async function insertFailedRecording(input: {
  leadId: string
  errorCode: ErrorCode
  screenshotBeforePath: string | null
  screenshotAfterPath: string | null
}): Promise<string> {
  const { data, error } = await getSupabaseAdmin()
    .from("recordings")
    .insert({
      lead_id: input.leadId,
      local_path: null,
      error_code: input.errorCode,
      screenshot_before_path: input.screenshotBeforePath,
      screenshot_after_path: input.screenshotAfterPath,
    })
    .select("id")
    .single()

  if (error) {
    throw new Error(`Failed to insert failed recording: ${error.message}`)
  }

  return data.id
}

export async function purgeRecording(recordingId: string): Promise<string | null> {
  const { data: existing, error: readError } = await getSupabaseAdmin()
    .from("recordings")
    .select("local_path")
    .eq("id", recordingId)
    .maybeSingle()

  if (readError) {
    throw new Error(`Failed to read recording for purge: ${readError.message}`)
  }
  if (!existing) return null

  const now = new Date().toISOString()
  const { error } = await getSupabaseAdmin()
    .from("recordings")
    .update({
      purged_at: now,
      local_path: null,
    })
    .eq("id", recordingId)

  if (error) {
    throw new Error(`Failed to purge recording: ${error.message}`)
  }

  return existing.local_path
}

export async function linkRecordingToCampaignLead(
  campaignLeadId: string,
  recordingId: string,
  options?: { invalidateVideo?: boolean },
): Promise<void> {
  const update: Database["public"]["Tables"]["campaign_leads"]["Update"] = {
    recording_id: recordingId,
  }

  // Polarity inversion vs merge: a fresh capture clears video_id so merge
  // re-encodes instead of skipping on the resume ladder.
  if (options?.invalidateVideo) {
    update.video_id = null
  }

  const { error } = await getSupabaseAdmin()
    .from("campaign_leads")
    .update(update)
    .eq("id", campaignLeadId)

  if (error) {
    throw new Error(`Failed to link recording: ${error.message}`)
  }
}

export async function writeStepLog(input: {
  scope: LogScope
  level: Database["public"]["Enums"]["log_level"]
  message: string
  campaignLeadId?: string | null
  jobRunId?: string | null
  meta?: Record<string, unknown>
}): Promise<void> {
  const { error } = await getSupabaseAdmin().from("logs").insert({
    level: input.level,
    scope: input.scope,
    message: input.message,
    campaign_lead_id: input.campaignLeadId ?? null,
    job_run_id: input.jobRunId ?? null,
    meta: (input.meta ?? {}) as Database["public"]["Tables"]["logs"]["Insert"]["meta"],
  })

  if (error) {
    console.error(`[${input.scope}] failed to write log:`, error.message)
  }
}

export async function writeRecorderLog(input: {
  level: Database["public"]["Enums"]["log_level"]
  message: string
  campaignLeadId?: string | null
  jobRunId?: string | null
  meta?: Record<string, unknown>
}): Promise<void> {
  await writeStepLog({ scope: "recorder", ...input })
}

export async function reloadCampaignLead(
  campaignLeadId: string,
): Promise<CampaignLeadRow | null> {
  const { data, error } = await getSupabaseAdmin()
    .from("campaign_leads")
    .select("*")
    .eq("id", campaignLeadId)
    .maybeSingle()

  if (error) {
    throw new Error(`Failed to reload campaign lead: ${error.message}`)
  }
  return data
}

export async function checkUsableRecording(leadId: string): Promise<boolean> {
  const { count, error } = await getSupabaseAdmin()
    .from("recordings")
    .select("id", { count: "exact", head: true })
    .eq("lead_id", leadId)
    .is("purged_at", null)
    .is("error_code", null)

  if (error) {
    throw new Error(`Failed to check recordings: ${error.message}`)
  }

  return (count ?? 0) > 0
}

/**
 * Conditional claim: update first; only if zero rows, select to distinguish
 * deleted (`gone`) from moved-on (`skipped`). `started_at` is set once on
 * first pickup and never overwritten (DB.md §5.4).
 */
export async function claimLead(campaignLeadId: string): Promise<ClaimResult> {
  const now = new Date().toISOString()

  const { data: firstPickup, error: firstError } = await getSupabaseAdmin()
    .from("campaign_leads")
    .update({ status: "processing", started_at: now })
    .eq("id", campaignLeadId)
    .eq("status", "queued")
    .is("started_at", null)
    .select("id")
    .maybeSingle()

  if (firstError) {
    throw new Error(`Failed to claim lead: ${firstError.message}`)
  }
  if (firstPickup) return "claimed"

  const { data: requeued, error: requeuedError } = await getSupabaseAdmin()
    .from("campaign_leads")
    .update({ status: "processing" })
    .eq("id", campaignLeadId)
    .eq("status", "queued")
    .select("id")
    .maybeSingle()

  if (requeuedError) {
    throw new Error(`Failed to claim lead: ${requeuedError.message}`)
  }
  if (requeued) return "claimed"

  const { data: fromProcessing, error: processingError } = await getSupabaseAdmin()
    .from("campaign_leads")
    .update({ status: "processing" })
    .eq("id", campaignLeadId)
    .eq("status", "processing")
    .select("id")
    .maybeSingle()

  if (processingError) {
    throw new Error(`Failed to claim lead: ${processingError.message}`)
  }
  if (fromProcessing) return "claimed"

  const { data: exists, error: existsError } = await getSupabaseAdmin()
    .from("campaign_leads")
    .select("id")
    .eq("id", campaignLeadId)
    .maybeSingle()

  if (existsError) {
    throw new Error(`Failed to check lead existence: ${existsError.message}`)
  }

  return exists ? "skipped" : "gone"
}

export async function insertPipelineEvent(input: {
  campaignLeadId: string
  kind: EventKind
  message: string
  step?: PipelineStep | null
  errorCode?: ErrorCode | null
  meta?: PipelineEventMeta
}): Promise<void> {
  const { error } = await getSupabaseAdmin().from("pipeline_events").insert({
    campaign_lead_id: input.campaignLeadId,
    kind: input.kind,
    step: input.step ?? null,
    message: input.message,
    error_code: input.errorCode ?? null,
    meta: (input.meta ?? {}) as Database["public"]["Tables"]["pipeline_events"]["Insert"]["meta"],
  })

  if (error) {
    throw new Error(`Failed to insert pipeline event: ${error.message}`)
  }
}

export async function openJobRun(input: {
  campaignLeadId: string
  step: PipelineStep
  attempt: number
  queueJobId: string
  workerId: string
}): Promise<string> {
  const { data, error } = await getSupabaseAdmin()
    .from("job_runs")
    .insert({
      campaign_lead_id: input.campaignLeadId,
      step: input.step,
      state: "running",
      attempt: input.attempt,
      queue_job_id: input.queueJobId,
      worker_id: input.workerId,
    })
    .select("id")
    .single()

  if (error) {
    throw new Error(`Failed to open job run: ${error.message}`)
  }

  return data.id
}

export async function closeJobRun(
  jobRunId: string,
  state: Database["public"]["Enums"]["job_state"],
  error?: { code: ErrorCode; detail: string },
): Promise<void> {
  const update: Database["public"]["Tables"]["job_runs"]["Update"] = {
    state,
    error_code: error?.code ?? null,
    error_detail: error?.detail ?? null,
  }

  if (state !== "interrupted") {
    update.finished_at = new Date().toISOString()
  }

  const { error: updateError } = await getSupabaseAdmin()
    .from("job_runs")
    .update(update)
    .eq("id", jobRunId)
    .eq("state", "running")

  if (updateError) {
    throw new Error(`Failed to close job run: ${updateError.message}`)
  }
}

export async function closeOpenJobRunForLead(
  campaignLeadId: string,
  state: Database["public"]["Enums"]["job_state"],
): Promise<string | null> {
  const { data: openRun, error: readError } = await getSupabaseAdmin()
    .from("job_runs")
    .select("id")
    .eq("campaign_lead_id", campaignLeadId)
    .eq("state", "running")
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (readError) {
    throw new Error(`Failed to read open job run: ${readError.message}`)
  }
  if (!openRun) return null

  await closeJobRun(openRun.id, state)
  return openRun.id
}

export async function updateLeadAfterStepSuccess(input: {
  campaignLeadId: string
  nextStep: PipelineStep | null
}): Promise<void> {
  const update: Database["public"]["Tables"]["campaign_leads"]["Update"] = {
    attempt_count: 0,
    error_code: null,
    error_detail: null,
  }

  if (input.nextStep) {
    update.current_step = input.nextStep
  }

  const { error } = await getSupabaseAdmin()
    .from("campaign_leads")
    .update(update)
    .eq("id", input.campaignLeadId)

  if (error) {
    throw new Error(`Failed to update lead after step success: ${error.message}`)
  }
}

export async function markLeadDeployed(input: {
  campaignLeadId: string
  netlifyUrl: string
}): Promise<void> {
  const now = new Date().toISOString()
  const { error } = await getSupabaseAdmin()
    .from("campaign_leads")
    .update({
      status: "deployed",
      netlify_url: input.netlifyUrl,
      deployed_at: now,
      attempt_count: 0,
      error_code: null,
      error_detail: null,
    })
    .eq("id", input.campaignLeadId)

  if (error) {
    throw new Error(`Failed to mark lead deployed: ${error.message}`)
  }
}

export async function markLeadPaused(input: {
  campaignLeadId: string
}): Promise<void> {
  const { error } = await getSupabaseAdmin()
    .from("campaign_leads")
    .update({
      status: "paused",
      current_step: "merge",
      error_code: "intro_missing",
      error_detail: "Campaign has no intro video assigned.",
    })
    .eq("id", input.campaignLeadId)

  if (error) {
    throw new Error(`Failed to pause lead: ${error.message}`)
  }
}

export async function markLeadFailed(input: {
  campaignLeadId: string
  errorCode: ErrorCode
  errorDetail: string
}): Promise<void> {
  const { error } = await getSupabaseAdmin()
    .from("campaign_leads")
    .update({
      status: "failed",
      error_code: input.errorCode,
      error_detail: input.errorDetail,
    })
    .eq("id", input.campaignLeadId)

  if (error) {
    throw new Error(`Failed to mark lead failed: ${error.message}`)
  }
}

export async function scheduleRetry(input: {
  campaignLeadId: string
  attemptCount: number
  step: PipelineStep
  errorCode: ErrorCode
  errorDetail: string
}): Promise<void> {
  const { error } = await getSupabaseAdmin()
    .from("campaign_leads")
    .update({
      status: "processing",
      attempt_count: input.attemptCount,
      error_code: input.errorCode,
      error_detail: input.errorDetail,
    })
    .eq("id", input.campaignLeadId)

  if (error) {
    throw new Error(`Failed to schedule retry: ${error.message}`)
  }
}

export async function setCurrentStep(
  campaignLeadId: string,
  step: PipelineStep,
): Promise<void> {
  const { error } = await getSupabaseAdmin()
    .from("campaign_leads")
    .update({ current_step: step })
    .eq("id", campaignLeadId)

  if (error) {
    throw new Error(`Failed to set current step: ${error.message}`)
  }
}

export async function writeWorkerLog(input: {
  level: Database["public"]["Enums"]["log_level"]
  message: string
  campaignLeadId?: string | null
  jobRunId?: string | null
  meta?: Record<string, unknown>
}): Promise<void> {
  const { error } = await getSupabaseAdmin().from("logs").insert({
    level: input.level,
    scope: "worker",
    message: input.message,
    campaign_lead_id: input.campaignLeadId ?? null,
    job_run_id: input.jobRunId ?? null,
    meta: (input.meta ?? {}) as Database["public"]["Tables"]["logs"]["Insert"]["meta"],
  })

  if (error) {
    console.error("[worker] failed to write log:", error.message)
  }
}

export async function listRecoverableLeads(graceMs?: number): Promise<
  Array<Pick<CampaignLeadRow, "id" | "status" | "updated_at" | "current_step">>
> {
  let query = getSupabaseAdmin()
    .from("campaign_leads")
    .select("id, status, updated_at, current_step")
    .in("status", ["queued", "processing"])

  if (graceMs != null && graceMs > 0) {
    const cutoff = new Date(Date.now() - graceMs).toISOString()
    query = query.lt("updated_at", cutoff)
  }

  const { data, error } = await query
    .order("updated_at", { ascending: true })
    .limit(SCAN_LIMIT)
  if (error) {
    throw new Error(`Failed to list recoverable leads: ${error.message}`)
  }

  if ((data?.length ?? 0) >= SCAN_LIMIT) {
    console.warn(
      `[recovery] listRecoverableLeads hit limit of ${SCAN_LIMIT}; backlog remains`,
    )
  }

  return data ?? []
}

export async function listOpenJobRuns(): Promise<
  Array<
    Pick<JobRunRow, "id" | "worker_id" | "campaign_lead_id" | "started_at">
  >
> {
  const { data, error } = await getSupabaseAdmin()
    .from("job_runs")
    .select("id, worker_id, campaign_lead_id, started_at")
    .eq("state", "running")
    .order("started_at", { ascending: false })
    .limit(SCAN_LIMIT)

  if (error) {
    throw new Error(`Failed to list open job runs: ${error.message}`)
  }

  if ((data?.length ?? 0) >= SCAN_LIMIT) {
    console.warn(
      `[recovery] listOpenJobRuns hit limit of ${SCAN_LIMIT}; backlog remains`,
    )
  }

  return data ?? []
}

export async function getIntroVideo(
  introVideoId: string,
): Promise<Pick<
  Database["public"]["Tables"]["intro_videos"]["Row"],
  "id" | "local_path" | "duration_ms"
> | null> {
  const { data, error } = await getSupabaseAdmin()
    .from("intro_videos")
    .select("id, local_path, duration_ms")
    .eq("id", introVideoId)
    .maybeSingle()

  if (error) {
    throw new Error(`Failed to load intro video: ${error.message}`)
  }

  return data
}

export async function getVideoForCampaignLead(
  campaignLeadId: string,
): Promise<VideoRow | null> {
  const { data, error } = await getSupabaseAdmin()
    .from("videos")
    .select("*")
    .eq("campaign_lead_id", campaignLeadId)
    .maybeSingle()

  if (error) {
    throw new Error(`Failed to load video row: ${error.message}`)
  }

  return data
}

export async function upsertVideoEncode(input: {
  campaignLeadId: string
  introVideoId: string | null
  masterPath: string
  webPath: string
  posterPath: string | null
  masterSizeBytes: number
  webSizeBytes: number
  durationMs: number
  stretchFactor: number
  usedSpeedFloor: boolean
}): Promise<string> {
  const now = new Date().toISOString()
  const { data, error } = await getSupabaseAdmin()
    .from("videos")
    .upsert(
      {
        campaign_lead_id: input.campaignLeadId,
        intro_video_id: input.introVideoId,
        master_path: input.masterPath,
        web_path: input.webPath,
        poster_path: input.posterPath,
        master_size_bytes: input.masterSizeBytes,
        web_size_bytes: input.webSizeBytes,
        duration_ms: input.durationMs,
        stretch_factor: input.stretchFactor,
        used_speed_floor: input.usedSpeedFloor,
        encoded_at: now,
        web_storage_key: null,
        web_public_url: null,
        uploaded_at: null,
        poster_storage_key: null,
      },
      { onConflict: "campaign_lead_id" },
    )
    .select("id")
    .single()

  if (error) {
    throw new Error(`Failed to upsert video encode: ${error.message}`)
  }

  return data.id
}

export async function linkVideoToCampaignLead(
  campaignLeadId: string,
  videoId: string,
): Promise<void> {
  const { error } = await getSupabaseAdmin()
    .from("campaign_leads")
    .update({ video_id: videoId })
    .eq("id", campaignLeadId)

  if (error) {
    throw new Error(`Failed to link video to campaign lead: ${error.message}`)
  }
}

/**
 * PostgREST reports no error when an UPDATE matches zero rows, so every video
 * update below selects the touched row back and treats a miss as a failure.
 * Reserving a key that lands nowhere would orphan the uploaded object.
 */
function assertVideoRowTouched(
  data: { id: string } | null,
  error: { message: string } | null,
  what: string,
  campaignLeadId: string,
): void {
  if (error) {
    throw new Error(`Failed to ${what}: ${error.message}`)
  }
  if (!data) {
    throw new Error(
      `Failed to ${what}: no video row for campaign lead ${campaignLeadId}`,
    )
  }
}

export async function reserveVideoStorageKey(input: {
  campaignLeadId: string
  webStorageKey: string
}): Promise<void> {
  const { data, error } = await getSupabaseAdmin()
    .from("videos")
    .update({ web_storage_key: input.webStorageKey })
    .eq("campaign_lead_id", input.campaignLeadId)
    .select("id")
    .maybeSingle()

  assertVideoRowTouched(
    data,
    error,
    "reserve video storage key",
    input.campaignLeadId,
  )
}

export async function updateVideoUpload(input: {
  campaignLeadId: string
  webPublicUrl: string
}): Promise<void> {
  const { data, error } = await getSupabaseAdmin()
    .from("videos")
    .update({
      web_public_url: input.webPublicUrl,
      uploaded_at: new Date().toISOString(),
    })
    .eq("campaign_lead_id", input.campaignLeadId)
    .select("id")
    .maybeSingle()

  assertVideoRowTouched(
    data,
    error,
    "update video upload",
    input.campaignLeadId,
  )
}

export async function updateVideoPosterUpload(input: {
  campaignLeadId: string
  posterStorageKey: string
}): Promise<void> {
  const { data, error } = await getSupabaseAdmin()
    .from("videos")
    .update({ poster_storage_key: input.posterStorageKey })
    .eq("campaign_lead_id", input.campaignLeadId)
    .select("id")
    .maybeSingle()

  assertVideoRowTouched(
    data,
    error,
    "update video poster upload",
    input.campaignLeadId,
  )
}

export async function updateVideoWebEncode(input: {
  campaignLeadId: string
  webPath: string
  webSizeBytes: number
}): Promise<void> {
  const { data, error } = await getSupabaseAdmin()
    .from("videos")
    .update({
      web_path: input.webPath,
      web_size_bytes: input.webSizeBytes,
    })
    .eq("campaign_lead_id", input.campaignLeadId)
    .select("id")
    .maybeSingle()

  assertVideoRowTouched(data, error, "update web encode", input.campaignLeadId)
}

export async function updateVideoPosterPath(input: {
  campaignLeadId: string
  posterPath: string
}): Promise<void> {
  const { data, error } = await getSupabaseAdmin()
    .from("videos")
    .update({ poster_path: input.posterPath })
    .eq("campaign_lead_id", input.campaignLeadId)
    .select("id")
    .maybeSingle()

  assertVideoRowTouched(
    data,
    error,
    "update video poster path",
    input.campaignLeadId,
  )
}

export async function discardMergeArtifacts(
  campaignLeadId: string,
): Promise<{ oldStorageKey: string | null; paths: string[] }> {
  const video = await getVideoForCampaignLead(campaignLeadId)
  if (!video) {
    return { oldStorageKey: null, paths: [] }
  }

  const paths = [video.master_path, video.web_path, video.poster_path].filter(
    (path): path is string => path != null,
  )

  const { error } = await getSupabaseAdmin()
    .from("videos")
    .delete()
    .eq("campaign_lead_id", campaignLeadId)

  if (error) {
    throw new Error(`Failed to discard video row: ${error.message}`)
  }

  return { oldStorageKey: video.web_storage_key, paths }
}

function assertLandingPageRowTouched(
  data: { id: string } | null,
  error: { message: string } | null,
  what: string,
  landingPageId: string,
): void {
  if (error) {
    throw new Error(`Failed to ${what}: ${error.message}`)
  }
  if (!data) {
    throw new Error(`Failed to ${what}: no landing page row ${landingPageId}`)
  }
}

export async function loadPageContext(
  campaignLeadId: string,
): Promise<PageContext | null> {
  const { data, error } = await getSupabaseAdmin()
    .from("campaign_leads")
    .select(
      `
      id,
      slug,
      landing_page_id,
      campaigns!inner (
        slug,
        landing_template,
        cta_type,
        cta_label,
        cta_url
      ),
      leads!inner (
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
      ),
      videos!videos_campaign_lead_id_fkey (
        web_public_url,
        poster_storage_key
      ),
      landing_pages!landing_pages_campaign_lead_id_fkey (
        id,
        content_sha1,
        deploy_status,
        path,
        unpublished_at
      )
    `,
    )
    .eq("id", campaignLeadId)
    .maybeSingle()

  if (error) {
    throw new Error(`Failed to load page context: ${error.message}`)
  }
  if (!data) return null

  const campaign = data.campaigns as PageContext["campaign"]
  const lead = data.leads as SampleLead
  const video = data.videos as Pick<
    VideoRow,
    "web_public_url" | "poster_storage_key"
  > | null
  const existingLandingPage = data.landing_pages as PageContext["existingLandingPage"]

  return {
    campaignLead: {
      id: data.id,
      slug: data.slug,
      landing_page_id: data.landing_page_id,
    },
    campaign,
    lead,
    video,
    existingLandingPage,
  }
}

export async function upsertLandingPage(input: {
  campaignLeadId: string
  path: string
  html: string
  contentSha1: string
  existing: PageContext["existingLandingPage"]
}): Promise<{ id: string; sha1Changed: boolean }> {
  if (input.existing) {
    const sha1Changed = input.existing.content_sha1 !== input.contentSha1
    const pathChanged = input.existing.path !== input.path

    if (!sha1Changed && !pathChanged) {
      return { id: input.existing.id, sha1Changed: false }
    }

    if (!sha1Changed) {
      const { data, error } = await getSupabaseAdmin()
        .from("landing_pages")
        .update({
          path: input.path,
          deploy_status: "pending",
          unpublished_at: null,
        })
        .eq("id", input.existing.id)
        .select("id")
        .maybeSingle()

      if (error?.code === "23505") {
        throw new Error(
          `Landing path ${input.path} is already used by another campaign lead.`,
        )
      }

      assertLandingPageRowTouched(
        data,
        error,
        "update landing page path",
        input.existing.id,
      )
      return { id: input.existing.id, sha1Changed: false }
    }

    const { data, error } = await getSupabaseAdmin()
      .from("landing_pages")
      .update({
        path: input.path,
        html: input.html,
        content_sha1: input.contentSha1,
        deploy_status: "pending",
        unpublished_at: null,
      })
      .eq("id", input.existing.id)
      .select("id")
      .maybeSingle()

    if (error?.code === "23505") {
      throw new Error(
        `Landing path ${input.path} is already used by another campaign lead.`,
      )
    }

    assertLandingPageRowTouched(
      data,
      error,
      "update landing page",
      input.existing.id,
    )
    return { id: input.existing.id, sha1Changed: true }
  }

  const { data, error } = await getSupabaseAdmin()
    .from("landing_pages")
    .insert({
      campaign_lead_id: input.campaignLeadId,
      path: input.path,
      html: input.html,
      content_sha1: input.contentSha1,
    })
    .select("id")
    .single()

  if (error) {
    if (error.code === "23505") {
      throw new Error(
        `Landing path ${input.path} is already used by another campaign lead.`,
      )
    }
    throw new Error(`Failed to insert landing page: ${error.message}`)
  }

  return { id: data.id, sha1Changed: true }
}

export async function linkLandingPageToCampaignLead(
  campaignLeadId: string,
  landingPageId: string,
): Promise<void> {
  const { data, error } = await getSupabaseAdmin()
    .from("campaign_leads")
    .update({ landing_page_id: landingPageId })
    .eq("id", campaignLeadId)
    .select("id")
    .maybeSingle()

  if (error) {
    throw new Error(`Failed to link landing page: ${error.message}`)
  }
  if (!data) {
    throw new Error(
      `Failed to link landing page: no campaign lead ${campaignLeadId}`,
    )
  }
}
