import { mkdir, stat } from "node:fs/promises"

import ffmpegPath from "ffmpeg-static"

import {
  moveFile,
  removeFile,
  sweepStaleMergeTemps,
} from "@/lib/local-file"
import {
  evaluateRecordingPrecheck,
  PURGED_RERECORD_NOTE,
} from "@/lib/recording-precheck"
import {
  PipelineStepError,
  ShutdownError,
} from "@/lib/pipeline-types"
import { resolveMany } from "@/lib/settings"
import {
  finalRelPath,
  mergeTempMasterRelPath,
  mergeTempPosterRelPath,
  mergeTempWebRelPath,
  posterRelPath,
  resolveMergeOutputDir,
  storageAbs,
  webRelPath,
} from "@/lib/storage"
import { extractPoster } from "@/lib/video/extract-poster"
import {
  buildMergeArgs,
  buildWebEncodeArgs,
  computeMergePlan,
} from "@/lib/video/merge-plan"
import {
  decideMergeAction,
  needsPosterSelfHeal,
} from "@/lib/video/merge-action"
import { withTranscodeLock } from "@/lib/video/mutex"
import { probe } from "@/lib/video/probe"
import {
  FfmpegProcessError,
  FfmpegTimeoutError,
  ProcessAbortedError,
  runProcess,
} from "@/lib/video/spawn"

import {
  discardMergeArtifacts,
  getIntroVideo,
  getUsableRecording,
  getVideoForCampaignLead,
  linkRecordingToCampaignLead,
  linkVideoToCampaignLead,
  updateVideoPosterPath,
  updateVideoWebEncode,
  upsertVideoEncode,
  writeStepLog,
} from "../db"
import type { StepContext } from "../steps/shared"
import { deleteStorageObject, uploadPosterImage, uploadWebVideo } from "./upload"

const FFMPEG_PATH = ffmpegPath!

export type MergeStepNote = {
  stretch_factor: number
  used_speed_floor: boolean
  hold_ms: number
  layout: string
  pip_px: number
  master_ms: number
  web_ms: number
  poster_ms: number
  poster_uploaded: boolean
}

async function pathExists(absPath: string): Promise<boolean> {
  try {
    await stat(absPath)
    return true
  } catch {
    return false
  }
}

function truncateStderr(stderr: string, maxBytes = 4096): string {
  const bytes = Buffer.from(stderr)
  if (bytes.length <= maxBytes) return stderr
  return bytes.subarray(-maxBytes).toString()
}

function classifyFfmpegFailure(error: unknown): never {
  if (error instanceof ProcessAbortedError) {
    throw new ShutdownError()
  }
  if (error instanceof FfmpegTimeoutError) {
    throw new PipelineStepError("ffmpeg_failure", error.message)
  }
  if (error instanceof FfmpegProcessError) {
    const detail = truncateStderr(error.stderr)
    if (/ENOSPC|No space left/i.test(error.stderr)) {
      throw new PipelineStepError("disk_full", "No space left on device.")
    }
    throw new PipelineStepError(
      "ffmpeg_failure",
      detail ? `${error.message}\n${detail}` : error.message,
    )
  }
  throw error
}

async function runFfmpeg(
  args: string[],
  signal: AbortSignal,
  timeoutMs: number,
): Promise<{ stderr: string; durationMs: number }> {
  const startedAt = Date.now()
  try {
    const { stderr } = await withTranscodeLock(() =>
      runProcess(FFMPEG_PATH, args, { signal, timeoutMs }),
    )
    return { stderr, durationMs: Date.now() - startedAt }
  } catch (error) {
    classifyFfmpegFailure(error)
  }
}

async function ensurePoster(input: {
  ctx: StepContext
  masterAbs: string
  posterAbs: string
  posterRel: string
  dIntroMs: number
  videoRow: Awaited<ReturnType<typeof getVideoForCampaignLead>>
}): Promise<{ durationMs: number; ok: boolean }> {
  const startedAt = Date.now()
  const atSec = Math.min(1, input.dIntroMs / 10_000)

  try {
    await extractPoster(input.masterAbs, input.posterAbs, atSec, {
      width: 720,
      quality: 4,
    })
    await moveFile(input.posterAbs, storageAbs(input.posterRel))

    if (input.videoRow) {
      await updateVideoPosterPath({
        campaignLeadId: input.ctx.lead.campaignLead.id,
        posterPath: input.posterRel,
      })
    }

    return { durationMs: Date.now() - startedAt, ok: true }
  } catch (error) {
    await writeStepLog({
      scope: "merger",
      level: "warn",
      message: "Poster extraction failed — continuing without poster.",
      campaignLeadId: input.ctx.lead.campaignLead.id,
      jobRunId: input.ctx.jobRunId,
      meta: {
        error: error instanceof Error ? error.message : String(error),
      },
    })
    return { durationMs: Date.now() - startedAt, ok: false }
  }
}

export async function runMerge(ctx: StepContext): Promise<MergeStepNote> {
  const { lead, signal, jobRunId } = ctx
  const { campaignLead, campaign } = lead

  const mergeSettings = await resolveMany(
    [
      "merge.layout",
      "merge.pip_scale",
      "merge.max_stretch_factor",
      "encode.web_crf",
      "encode.web_audio_kbps",
      "encode.merge_timeout_ms",
    ],
    {
      "merge.layout": {
        campaign: campaign.merge_layout,
        lead: campaignLead.merge_layout,
      },
      "merge.pip_scale": {
        campaign: campaign.pip_scale,
        lead: campaignLead.pip_scale,
      },
    },
  )
  const mergeTimeoutMs = mergeSettings["encode.merge_timeout_ms"]

  if (!campaign.intro_video_id) {
    throw new PipelineStepError("intro_missing", "Campaign has no intro video.")
  }

  const intro = await getIntroVideo(campaign.intro_video_id)
  if (!intro?.local_path) {
    throw new PipelineStepError("missing_asset", "Intro video file is missing.")
  }

  const existing = await getUsableRecording(lead.lead.id)
  const precheck = await evaluateRecordingPrecheck({
    recording: existing,
    forcedRerecord: false,
  })

  if (precheck.action === "missing_asset") {
    throw new PipelineStepError(
      "missing_asset",
      "Recording file is missing on disk.",
    )
  }

  if (precheck.action === "record_fresh") {
    throw new PipelineStepError(
      "missing_asset",
      "Lead has no linked recording.",
    )
  }

  if (precheck.action === "record_purged") {
    throw new PipelineStepError("missing_asset", PURGED_RERECORD_NOTE)
  }

  if (campaignLead.recording_id !== precheck.recordingId) {
    await linkRecordingToCampaignLead(campaignLead.id, precheck.recordingId)
    await writeStepLog({
      scope: "merger",
      level: "info",
      message: "Linked existing lead recording to campaign lead.",
      campaignLeadId: campaignLead.id,
      jobRunId,
      meta: { recordingId: precheck.recordingId },
    })
  }

  const recordingLocalPath = precheck.path
  const introAbs = storageAbs(intro.local_path)

  if (!(await pathExists(introAbs))) {
    throw new PipelineStepError("missing_asset", "Intro video file is missing.")
  }

  const videoRow = await getVideoForCampaignLead(campaignLead.id)
  const outputDir = resolveMergeOutputDir({
    recordingLocalPath,
    videoMasterPath: videoRow?.master_path ?? null,
  })
  const outputDirAbs = storageAbs(outputDir)
  await mkdir(outputDirAbs, { recursive: true })
  await sweepStaleMergeTemps(outputDirAbs)

  const masterRel = finalRelPath(outputDir)
  const webRel = webRelPath(outputDir)
  const posterRel = posterRelPath(outputDir)
  const masterAbs = storageAbs(masterRel)
  const webAbs = storageAbs(webRel)

  const masterExists = await pathExists(masterAbs)
  let webExists = false
  if (videoRow?.uploaded_at == null) {
    webExists = await pathExists(webAbs)
  }

  const posterExists = videoRow?.poster_path
    ? await pathExists(storageAbs(videoRow.poster_path))
    : false

  if (campaignLead.video_id != null && videoRow && !videoRow.encoded_at) {
    await writeStepLog({
      scope: "merger",
      level: "warn",
      message: "Video row linked without encoded_at — treating as discard+full.",
      campaignLeadId: campaignLead.id,
      jobRunId,
    })
  }

  let action = decideMergeAction({
    videoIdLinked: campaignLead.video_id != null,
    hasRow: videoRow != null,
    encodedAt: videoRow?.encoded_at ?? null,
    masterExists,
    uploadedAt: videoRow?.uploaded_at ?? null,
    webExists,
  })

  let uploadReservedKey: string | null = videoRow?.web_storage_key ?? null

  if (action === "discard+full") {
    const discarded = await discardMergeArtifacts(campaignLead.id)
    uploadReservedKey = null
    for (const relPath of discarded.paths) {
      await removeFile(storageAbs(relPath)).catch(() => undefined)
    }
    if (discarded.oldStorageKey) {
      await deleteStorageObject(discarded.oldStorageKey, {
        campaignLeadId: campaignLead.id,
        jobRunId,
      })
    }
    action = "full"
  }

  if (action === "missing_asset") {
    throw new PipelineStepError(
      "missing_asset",
      "Master video file is missing on disk.",
    )
  }

  const dIntroMs = intro.duration_ms
  const dRecMs =
    existing?.duration_ms ?? (await probe(storageAbs(recordingLocalPath))).durationMs
  const plan = computeMergePlan({
    dIntroMs,
    dRecMs,
    maxStretch: mergeSettings["merge.max_stretch_factor"],
    pipScale: mergeSettings["merge.pip_scale"],
    layout: mergeSettings["merge.layout"],
  })

  for (const warning of plan.warnings) {
    await writeStepLog({
      scope: "merger",
      level: "warn",
      message: warning,
      campaignLeadId: campaignLead.id,
      jobRunId,
    })
  }

  let masterMs = 0
  let webMs = 0
  let posterMs = 0
  // Tracks *attempted*, not *succeeded*: a poster that just failed to extract
  // would fail again from the same master, so the self-heal below must skip it.
  let posterAttempted = false
  let durationMs = videoRow?.duration_ms ?? plan.targetMs
  let stretchFactor = Number(videoRow?.stretch_factor ?? plan.stretchFactor)
  let usedSpeedFloor = videoRow?.used_speed_floor ?? plan.usedSpeedFloor
  let shouldUpload = false
  let shouldUploadPoster = false
  let posterUploaded = false

  if (action === "full") {
    const recordingAbs = storageAbs(recordingLocalPath)
    const masterTempAbs = storageAbs(
      mergeTempMasterRelPath(outputDir, jobRunId),
    )
    const webTempAbs = storageAbs(mergeTempWebRelPath(outputDir, jobRunId))

    const masterResult = await runFfmpeg(
      buildMergeArgs({
        recordingPath: recordingAbs,
        introPath: introAbs,
        outputPath: masterTempAbs,
        plan,
      }),
      signal,
      mergeTimeoutMs,
    )
    masterMs = masterResult.durationMs
    await writeStepLog({
      scope: "merger",
      level: "info",
      message: "Master merge encode succeeded.",
      campaignLeadId: campaignLead.id,
      jobRunId,
    })

    const probedMaster = await probe(masterTempAbs)
    durationMs = probedMaster.durationMs
    stretchFactor = plan.stretchFactor
    usedSpeedFloor = plan.usedSpeedFloor
    await moveFile(masterTempAbs, masterAbs)

    const webResult = await runFfmpeg(
      buildWebEncodeArgs({
        masterPath: masterAbs,
        outputPath: webTempAbs,
        webCrf: mergeSettings["encode.web_crf"],
        webAudioKbps: mergeSettings["encode.web_audio_kbps"],
      }),
      signal,
      mergeTimeoutMs,
    )
    webMs = webResult.durationMs
    await writeStepLog({
      scope: "merger",
      level: "info",
      message: "Web encode succeeded.",
      campaignLeadId: campaignLead.id,
      jobRunId,
    })
    await moveFile(webTempAbs, webAbs)

    const posterTempAbs = storageAbs(
      mergeTempPosterRelPath(outputDir, jobRunId),
    )
    const posterResult = await ensurePoster({
      ctx,
      masterAbs,
      posterAbs: posterTempAbs,
      posterRel,
      dIntroMs,
      videoRow,
    })
    posterMs = posterResult.durationMs
    posterAttempted = true
    shouldUploadPoster = posterResult.ok

    const videoId = await upsertVideoEncode({
      campaignLeadId: campaignLead.id,
      introVideoId: campaign.intro_video_id,
      masterPath: masterRel,
      webPath: webRel,
      posterPath: posterResult.ok ? posterRel : null,
      masterSizeBytes: (await stat(masterAbs)).size,
      webSizeBytes: (await stat(webAbs)).size,
      durationMs,
      stretchFactor,
      usedSpeedFloor,
    })

    await linkVideoToCampaignLead(campaignLead.id, videoId)
    uploadReservedKey = null
    shouldUpload = true
  } else if (action === "web+upload") {
    const webTempAbs = storageAbs(mergeTempWebRelPath(outputDir, jobRunId))
    const webResult = await runFfmpeg(
      buildWebEncodeArgs({
        masterPath: masterAbs,
        outputPath: webTempAbs,
        webCrf: mergeSettings["encode.web_crf"],
        webAudioKbps: mergeSettings["encode.web_audio_kbps"],
      }),
      signal,
      mergeTimeoutMs,
    )
    webMs = webResult.durationMs
    await writeStepLog({
      scope: "merger",
      level: "info",
      message: "Web encode succeeded.",
      campaignLeadId: campaignLead.id,
      jobRunId,
    })
    await moveFile(webTempAbs, webAbs)
    await updateVideoWebEncode({
      campaignLeadId: campaignLead.id,
      webPath: webRel,
      webSizeBytes: (await stat(webAbs)).size,
    })
    shouldUpload = true
  } else if (action === "upload") {
    shouldUpload = true
  }

  if (
    masterExists &&
    !posterAttempted &&
    needsPosterSelfHeal({
      posterPath: videoRow?.poster_path ?? null,
      posterExists,
    })
  ) {
    const posterTempAbs = storageAbs(
      mergeTempPosterRelPath(outputDir, jobRunId),
    )
    const posterResult = await ensurePoster({
      ctx,
      masterAbs,
      posterAbs: posterTempAbs,
      posterRel,
      dIntroMs,
      videoRow,
    })
    posterMs = posterResult.durationMs
    posterAttempted = true
    shouldUploadPoster = posterResult.ok
  }

  const latestVideoRow = await getVideoForCampaignLead(campaignLead.id)
  if (
    !shouldUploadPoster &&
    latestVideoRow?.uploaded_at &&
    !latestVideoRow.poster_storage_key
  ) {
    const localPoster = latestVideoRow.poster_path ?? posterRel
    if (localPoster && (await pathExists(storageAbs(localPoster)))) {
      shouldUploadPoster = true
    }
  }

  let videoStorageKey =
    uploadReservedKey ?? latestVideoRow?.web_storage_key ?? null

  if (shouldUpload) {
    const uploadResult = await uploadWebVideo({
      campaignLeadId: campaignLead.id,
      webAbsPath: webAbs,
      jobRunId,
      reservedKey: uploadReservedKey,
    })
    videoStorageKey = uploadResult.storageKey
  }

  if (shouldUploadPoster) {
    const localPoster = latestVideoRow?.poster_path ?? posterRel
    if (localPoster && (await pathExists(storageAbs(localPoster)))) {
      try {
        await uploadPosterImage({
          campaignLeadId: campaignLead.id,
          posterAbsPath: storageAbs(localPoster),
          jobRunId,
          webStorageKey: videoStorageKey,
        })
        posterUploaded = true
      } catch (error) {
        await writeStepLog({
          scope: "merger",
          level: "warn",
          message: "Poster upload failed — continuing without remote poster.",
          campaignLeadId: campaignLead.id,
          jobRunId,
          meta: {
            error: error instanceof Error ? error.message : String(error),
          },
        })
      }
    }
  }

  return {
    stretch_factor: stretchFactor,
    used_speed_floor: usedSpeedFloor,
    hold_ms: plan.holdMs,
    layout: plan.layout,
    pip_px: plan.pipW,
    master_ms: masterMs,
    web_ms: webMs,
    poster_ms: posterMs,
    poster_uploaded: posterUploaded,
  }
}
