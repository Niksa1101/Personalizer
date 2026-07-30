import type { SupabaseClient } from "@supabase/supabase-js"

import {
  emptyCleanupCounts,
  type CleanupCounts,
} from "@/lib/cleanup-state"
import type { Database } from "@/lib/database.types"
import {
  DAILY_TEMP_PATTERN,
  type DeleteOutcome,
  deleteContainedRelPath,
  sweepStaleImportUploadTemps,
  sweepStaleIntroUploadTemps,
  sweepStaleMergeTemps,
  sweepStaleRecorderTemps,
} from "@/lib/local-file"
import { storageAbs } from "@/lib/storage"

import { deleteLocalWebCopy, purgeRecordingAfterDelete } from "../db"

const MAX_ROWS_PER_SWEEP = 500
const MAX_LEADS_PER_SWEEP = 500
const CANDIDATE_ROW_LIMIT = 2000
const CHUNK_SIZE = 150
const PAGE_SIZE = 500

export type CleanupSweepDeps = {
  supabase: SupabaseClient<Database>
  deleteFile?: (relPath: string) => Promise<DeleteOutcome>
  now?: () => Date
  recDays: number
  shotDays: number
  dryRun?: boolean
  logWarn?: (message: string) => void
  logError?: (message: string) => void
}

export type CleanupSweepResult = {
  counts: CleanupCounts
  bytesFreed: number
  truncated: boolean
  errorSamples: string[]
}

export type ScreenshotCandidateLeads = {
  leadIds: string[]
  truncated: boolean
}

function chunked<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size))
  }
  return out
}

function cutoffIso(now: Date, days: number): string {
  const cutoff = new Date(now)
  cutoff.setDate(cutoff.getDate() - days)
  return cutoff.toISOString()
}

async function loadBusyLeadIds(
  supabase: SupabaseClient<Database>,
  leadIds: string[],
): Promise<Set<string>> {
  const busy = new Set<string>()
  for (const chunk of chunked(leadIds, CHUNK_SIZE)) {
    if (chunk.length === 0) continue
    const { data, error } = await supabase
      .from("campaign_leads")
      .select("lead_id, status")
      .in("lead_id", chunk)
      .in("status", ["queued", "processing"])
    if (error) throw error
    for (const row of data ?? []) busy.add(row.lead_id)
  }
  return busy
}

async function loadFailedLeadIds(
  supabase: SupabaseClient<Database>,
  leadIds: string[],
): Promise<Set<string>> {
  const failed = new Set<string>()
  for (const chunk of chunked(leadIds, CHUNK_SIZE)) {
    if (chunk.length === 0) continue
    const { data, error } = await supabase
      .from("campaign_leads")
      .select("lead_id, status")
      .in("lead_id", chunk)
      .eq("status", "failed")
    if (error) throw error
    for (const row of data ?? []) failed.add(row.lead_id)
  }
  return failed
}

export async function collectScreenshotCandidateLeadIds(
  supabase: SupabaseClient<Database>,
  screenshotCutoff: string,
): Promise<ScreenshotCandidateLeads> {
  const { data: candidateRows, error } = await supabase
    .from("recordings")
    .select("lead_id, created_at")
    .or(
      "screenshot_before_path.not.is.null,screenshot_after_path.not.is.null",
    )
    .lt("created_at", screenshotCutoff)
    .order("created_at", { ascending: true })
    .limit(CANDIDATE_ROW_LIMIT)

  if (error) throw error

  const leadIds: string[] = []
  const seen = new Set<string>()
  for (const row of candidateRows ?? []) {
    if (seen.has(row.lead_id)) continue
    seen.add(row.lead_id)
    leadIds.push(row.lead_id)
    if (leadIds.length >= MAX_LEADS_PER_SWEEP) break
  }

  return {
    leadIds,
    truncated:
      leadIds.length >= MAX_LEADS_PER_SWEEP ||
      (candidateRows ?? []).length >= CANDIDATE_ROW_LIMIT,
  }
}

type RecordingRow = {
  id: string
  lead_id: string
  local_path: string
  recorded_at: string
  file_size_bytes: number | null
}

async function sweepRecordings(
  deps: CleanupSweepDeps,
  counts: CleanupCounts,
  bytesFreed: { total: number },
  errorSamples: string[],
  now: Date,
  cutoff: string,
  busyLeads: Set<string>,
  deleteFile: (relPath: string) => Promise<DeleteOutcome>,
  collectError: (error: unknown, context: string) => void,
): Promise<boolean> {
  const { data: candidates, error } = await deps.supabase
    .from("recordings")
    .select("id, lead_id, local_path, recorded_at, file_size_bytes")
    .is("purged_at", null)
    .not("local_path", "is", null)
    .lt("recorded_at", cutoff)
    .order("recorded_at", { ascending: true })
    .limit(MAX_ROWS_PER_SWEEP)

  if (error) throw error

  const truncated = (candidates ?? []).length >= MAX_ROWS_PER_SWEEP

  for (const row of (candidates ?? []) as RecordingRow[]) {
    counts.rowsVisited += 1

    if (busyLeads.has(row.lead_id)) {
      counts.recordingsSkippedBusy += 1
      continue
    }

    if (deps.dryRun) {
      counts.recordingsPurged += 1
      continue
    }

    try {
      const outcome = await deleteFile(row.local_path)
      if (!outcome.deleted && !outcome.absent) continue

      if (outcome.absent && !outcome.deleted) {
        counts.recordingsAlreadyGone += 1
      }

      const { updated } = await purgeRecordingAfterDelete({
        recordingId: row.id,
        localPath: row.local_path,
      })

      if (!updated) {
        counts.recordingsSkippedRevived += 1
        continue
      }

      counts.recordingsPurged += 1
      bytesFreed.total += row.file_size_bytes ?? 0
    } catch (error) {
      collectError(error, `recording ${row.id}`)
    }
  }

  return truncated
}

type VideoCandidate = {
  id: string
  campaign_lead_id: string
  web_path: string
  web_size_bytes: number | null
  lead_id?: string
}

async function sweepWebCopies(
  deps: CleanupSweepDeps,
  counts: CleanupCounts,
  bytesFreed: { total: number },
  errorSamples: string[],
  busyLeads: Set<string>,
  deleteFile: (relPath: string) => Promise<DeleteOutcome>,
  collectError: (error: unknown, context: string) => void,
  logWarn: (message: string) => void,
): Promise<boolean> {
  const { data: videos, error } = await deps.supabase
    .from("videos")
    .select("id, campaign_lead_id, web_path, web_size_bytes")
    .not("web_path", "is", null)
    .not("uploaded_at", "is", null)
    .not("web_public_url", "is", null)
    .order("uploaded_at", { ascending: true })
    .limit(MAX_ROWS_PER_SWEEP)

  if (error) throw error

  const truncated = (videos ?? []).length >= MAX_ROWS_PER_SWEEP
  const rows = videos ?? []
  if (rows.length === 0) return truncated

  const campaignLeadIds = rows.map((r) => r.campaign_lead_id)
  const deployedIds = new Set<string>()
  const leadByCampaignLead = new Map<string, string>()

  for (const chunk of chunked(campaignLeadIds, CHUNK_SIZE)) {
    const [{ data: pages, error: pagesError }, { data: cls, error: clsError }] =
      await Promise.all([
        deps.supabase
          .from("landing_pages")
          .select("campaign_lead_id, deployed_at")
          .in("campaign_lead_id", chunk)
          .not("deployed_at", "is", null),
        deps.supabase
          .from("campaign_leads")
          .select("id, lead_id")
          .in("id", chunk),
      ])

    if (pagesError) throw pagesError
    if (clsError) throw clsError

    for (const page of pages ?? []) deployedIds.add(page.campaign_lead_id)
    for (const cl of cls ?? []) leadByCampaignLead.set(cl.id, cl.lead_id)
  }

  const enriched: VideoCandidate[] = rows.map((row) => ({
    ...row,
    web_path: row.web_path!,
    lead_id: leadByCampaignLead.get(row.campaign_lead_id),
  }))

  const byPath = new Map<string, VideoCandidate[]>()
  for (const row of enriched) {
    const group = byPath.get(row.web_path) ?? []
    group.push(row)
    byPath.set(row.web_path, group)
  }

  for (const [webPath, group] of byPath) {
    if (group.length > 1) {
      logWarn(
        `cleanup: ${group.length} videos rows share web_path ${webPath}`,
      )
    }

    const allDeployed = group.every((r) => deployedIds.has(r.campaign_lead_id))
    if (!allDeployed) {
      counts.webCopiesSkippedShared += group.length > 1 ? 1 : 0
      continue
    }

    const anyBusy = group.some(
      (r) => r.lead_id != null && busyLeads.has(r.lead_id),
    )
    if (anyBusy) {
      counts.webCopiesSkippedBusy += 1
      continue
    }

    if (deps.dryRun) {
      counts.webCopiesDeleted += 1
      continue
    }

    try {
      await deleteLocalWebCopy({
        webPath,
        campaignLeadIds: group.map((r) => r.campaign_lead_id),
      })
      counts.webCopiesDeleted += 1
      bytesFreed.total += group[0]?.web_size_bytes ?? 0
    } catch (error) {
      collectError(error, `web copy ${webPath}`)
    }
  }

  return truncated
}

export type ScreenshotRecordingRow = {
  id: string
  lead_id: string
  created_at: string
  screenshot_before_path: string | null
  screenshot_after_path: string | null
}

export type ScreenshotPathRef = {
  rowId: string
  column: "screenshot_before_path" | "screenshot_after_path"
  relPath: string
}

function collectScreenshotPathRefs(
  rows: ScreenshotRecordingRow[],
): ScreenshotPathRef[] {
  const refs: ScreenshotPathRef[] = []
  for (const row of rows) {
    if (row.screenshot_before_path) {
      refs.push({
        rowId: row.id,
        column: "screenshot_before_path",
        relPath: row.screenshot_before_path,
      })
    }
    if (row.screenshot_after_path) {
      refs.push({
        rowId: row.id,
        column: "screenshot_after_path",
        relPath: row.screenshot_after_path,
      })
    }
  }
  return refs
}

function screenshotRefKey(ref: ScreenshotPathRef): string {
  return `${ref.rowId}:${ref.column}`
}

async function sweepScreenshots(
  deps: CleanupSweepDeps,
  counts: CleanupCounts,
  screenshotCutoff: string,
  candidates: ScreenshotCandidateLeads,
  busyLeads: Set<string>,
  deleteFile: (relPath: string) => Promise<DeleteOutcome>,
  collectError: (error: unknown, context: string) => void,
): Promise<{ truncated: boolean; touchedLeadDirs: Set<string> }> {
  const { leadIds, truncated } = candidates

  if (leadIds.length === 0) {
    return { truncated, touchedLeadDirs: new Set() }
  }

  const allRows: ScreenshotRecordingRow[] = []
  for (const chunk of chunked(leadIds, 100)) {
    let from = 0
    for (;;) {
      const { data: page, error: pageError } = await deps.supabase
        .from("recordings")
        .select(
          "id, lead_id, created_at, screenshot_before_path, screenshot_after_path",
        )
        .in("lead_id", chunk)
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .range(from, from + PAGE_SIZE - 1)

      if (pageError) throw pageError
      allRows.push(...((page ?? []) as ScreenshotRecordingRow[]))
      if ((page ?? []).length < PAGE_SIZE) break
      from += PAGE_SIZE
    }
  }

  const rowsByLead = new Map<string, ScreenshotRecordingRow[]>()
  for (const row of allRows) {
    const list = rowsByLead.get(row.lead_id) ?? []
    list.push(row)
    rowsByLead.set(row.lead_id, list)
  }

  const eligibleByLead = reduceNewestPerLead(allRows, screenshotCutoff)
  const failedLeads = await loadFailedLeadIds(deps.supabase, leadIds)
  const touchedLeadDirs = new Set<string>()

  for (const leadId of leadIds) {
    counts.screenshotLeadsVisited += 1

    if (!eligibleByLead.has(leadId)) continue

    const rows = rowsByLead.get(leadId) ?? []
    if (rows.length === 0) continue

    if (busyLeads.has(leadId)) {
      counts.screenshotLeadsSkippedBusy += 1
      continue
    }

    if (failedLeads.has(leadId)) {
      counts.screenshotLeadsSpared += 1
      continue
    }

    const pathRefs = collectScreenshotPathRefs(rows)
    if (pathRefs.length === 0) continue

    if (deps.dryRun) {
      counts.screenshotLeadsPruned += 1
      counts.screenshotFilesDeleted += new Set(pathRefs.map((ref) => ref.relPath))
        .size
      continue
    }

    const confirmedGone = new Set<string>()
    const uniquePaths = [...new Set(pathRefs.map((ref) => ref.relPath))]

    for (const relPath of uniquePaths) {
      try {
        const outcome = await deleteFile(relPath)
        if (outcome.deleted || outcome.absent) {
          for (const ref of pathRefs.filter((entry) => entry.relPath === relPath)) {
            confirmedGone.add(screenshotRefKey(ref))
          }
        }
      } catch (error) {
        collectError(error, `screenshot ${relPath}`)
      }
    }

    if (confirmedGone.size === 0) continue

    for (const ref of pathRefs) {
      if (!confirmedGone.has(screenshotRefKey(ref))) continue

      const update =
        ref.column === "screenshot_before_path"
          ? { screenshot_before_path: null }
          : { screenshot_after_path: null }

      const { error: updateError } = await deps.supabase
        .from("recordings")
        .update(update)
        .eq("id", ref.rowId)

      if (updateError) {
        collectError(updateError, `null screenshot column ${ref.rowId}`)
      }
    }

    counts.screenshotLeadsPruned += 1
    counts.screenshotFilesDeleted += uniquePaths.filter((relPath) =>
      pathRefs.some(
        (ref) =>
          ref.relPath === relPath && confirmedGone.has(screenshotRefKey(ref)),
      ),
    ).length

    const firstPath = pathRefs[0]?.relPath
    if (firstPath) {
      const parts = firstPath.split("/").filter(Boolean)
      parts.pop()
      touchedLeadDirs.add(parts.join("/"))
    }
  }

  return { truncated, touchedLeadDirs }
}

export async function runCleanupSweeps(
  deps: CleanupSweepDeps,
): Promise<CleanupSweepResult> {
  const counts = emptyCleanupCounts()
  const bytesFreed = { total: 0 }
  const errorSamples: string[] = []
  const now = deps.now?.() ?? new Date()
  const deleteFile = deps.deleteFile ?? deleteContainedRelPath
  const logWarn = deps.logWarn ?? ((msg) => console.warn(msg))
  const logError = deps.logError ?? ((msg) => console.error(msg))

  const collectError = (error: unknown, context: string) => {
    counts.errors += 1
    if (errorSamples.length < 10) {
      const message =
        error instanceof Error ? error.message : String(error)
      errorSamples.push(`${context}: ${message}`)
    }
  }

  if (
    !Number.isInteger(deps.recDays) ||
    deps.recDays < 1 ||
    !Number.isInteger(deps.shotDays) ||
    deps.shotDays < 1
  ) {
    logError(
      `cleanup: refusing retention_days rec=${deps.recDays} shot=${deps.shotDays}`,
    )
    return { counts, bytesFreed: 0, truncated: false, errorSamples }
  }

  const recordingCutoff = cutoffIso(now, deps.recDays)
  const screenshotCutoff = cutoffIso(now, deps.shotDays)
  // Screenshot PNGs have no reliable size column; bytesFreed stays 0 for sweep 3.

  const allLeadIds = new Set<string>()

  const { data: recCandidates } = await deps.supabase
    .from("recordings")
    .select("lead_id")
    .is("purged_at", null)
    .not("local_path", "is", null)
    .lt("recorded_at", recordingCutoff)
    .limit(MAX_ROWS_PER_SWEEP)

  for (const row of recCandidates ?? []) allLeadIds.add(row.lead_id)

  const { data: webCandidates } = await deps.supabase
    .from("videos")
    .select("campaign_lead_id")
    .not("web_path", "is", null)
    .limit(MAX_ROWS_PER_SWEEP)

  const webClIds = (webCandidates ?? []).map((r) => r.campaign_lead_id)
  if (webClIds.length > 0) {
    for (const chunk of chunked(webClIds, CHUNK_SIZE)) {
      const { data: cls } = await deps.supabase
        .from("campaign_leads")
        .select("lead_id")
        .in("id", chunk)
      for (const cl of cls ?? []) allLeadIds.add(cl.lead_id)
    }
  }

  const screenshotCandidates = await collectScreenshotCandidateLeadIds(
    deps.supabase,
    screenshotCutoff,
  )
  for (const leadId of screenshotCandidates.leadIds) allLeadIds.add(leadId)

  const busyLeads = await loadBusyLeadIds(deps.supabase, [...allLeadIds])

  let truncated = false
  truncated =
    (await sweepRecordings(
      deps,
      counts,
      bytesFreed,
      errorSamples,
      now,
      recordingCutoff,
      busyLeads,
      deleteFile,
      collectError,
    )) || truncated

  truncated =
    (await sweepWebCopies(
      deps,
      counts,
      bytesFreed,
      errorSamples,
      busyLeads,
      deleteFile,
      collectError,
      logWarn,
    )) || truncated

  const screenshotResult = await sweepScreenshots(
    deps,
    counts,
    screenshotCutoff,
    screenshotCandidates,
    busyLeads,
    deleteFile,
    collectError,
  )
  truncated = screenshotResult.truncated || truncated

  if (!deps.dryRun) {
    for (const leadDir of screenshotResult.touchedLeadDirs) {
      try {
        await sweepStaleMergeTemps(
          storageAbs(leadDir),
          10 * 60 * 1000,
          DAILY_TEMP_PATTERN,
        )
        counts.tempsRemoved += 1
      } catch (error) {
        collectError(error, `merge temps ${leadDir}`)
      }
    }

    try {
      await sweepStaleRecorderTemps(storageAbs("tmp"))
      counts.tempsRemoved += 1
      await sweepStaleIntroUploadTemps(storageAbs("tmp"))
      counts.tempsRemoved += 1
      await sweepStaleImportUploadTemps(storageAbs("tmp"))
      counts.tempsRemoved += 1
    } catch (error) {
      collectError(error, "tmp sweeps")
    }
  }

  return {
    counts,
    bytesFreed: bytesFreed.total,
    truncated,
    errorSamples,
  }
}

/** Exported for unit tests — newest row per lead reduction. */
export function reduceNewestPerLead(
  rows: ScreenshotRecordingRow[],
  screenshotCutoff: string,
): Map<string, ScreenshotRecordingRow> {
  const byLead = new Map<string, ScreenshotRecordingRow>()
  for (const row of rows) {
    const existing = byLead.get(row.lead_id)
    if (!existing) {
      byLead.set(row.lead_id, row)
      continue
    }
    const ca = Date.parse(row.created_at)
    const cb = Date.parse(existing.created_at)
    if (ca > cb || (ca === cb && row.id > existing.id)) {
      byLead.set(row.lead_id, row)
    }
  }
  for (const [leadId, row] of [...byLead]) {
    if (row.created_at >= screenshotCutoff) byLead.delete(leadId)
  }
  return byLead
}

/** Exported for unit tests — group videos by web_path. */
export function groupVideosByWebPath<T extends { web_path: string }>(
  rows: T[],
): Map<string, T[]> {
  const byPath = new Map<string, T[]>()
  for (const row of rows) {
    const group = byPath.get(row.web_path) ?? []
    group.push(row)
    byPath.set(row.web_path, group)
  }
  return byPath
}

export {
  MAX_ROWS_PER_SWEEP,
  MAX_LEADS_PER_SWEEP,
  CANDIDATE_ROW_LIMIT,
  collectScreenshotPathRefs,
}
