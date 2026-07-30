import { stat } from "node:fs/promises"

import { deleteContainedRelPath } from "@/lib/local-file"
import { PipelineStepError } from "@/lib/pipeline-types"
import {
  evaluateRecordingPrecheck,
  PURGED_RERECORD_NOTE,
  type FileStat,
  type UsableRecordingRow,
} from "@/lib/recording-precheck"
import { storageAbs } from "@/lib/storage"

import {
  getLatestRecordingForPrecheck,
  insertPipelineEvent,
  linkRecordingToCampaignLead,
  purgeRecording,
  writeRecorderLog,
} from "../db"

export type RecordPrecheckGateDeps = {
  insertPipelineEvent?: typeof insertPipelineEvent
  purgeRecording?: typeof purgeRecording
}

export async function runRecordPrecheckGate(input: {
  campaignLeadId: string
  leadId: string
  forcedRerecord: boolean
  statFile?: FileStat
  /** Test hook — skip DB load when set (including explicit null). */
  recording?: UsableRecordingRow | null
  deps?: RecordPrecheckGateDeps
}): Promise<"reuse" | "capture"> {
  const insertEvent = input.deps?.insertPipelineEvent ?? insertPipelineEvent
  const purgeRow = input.deps?.purgeRecording ?? purgeRecording

  const statFile =
    input.statFile ??
    (async (relPath: string) => {
      try {
        await stat(storageAbs(relPath))
        return { exists: true }
      } catch {
        return { exists: false }
      }
    })

  const existing =
    input.recording !== undefined
      ? input.recording
      : await getLatestRecordingForPrecheck(input.leadId)
  const precheck = await evaluateRecordingPrecheck({
    recording: existing,
    forcedRerecord: input.forcedRerecord,
    statFile,
  })

  if (precheck.action === "missing_asset") {
    throw new PipelineStepError(
      "missing_asset",
      "Recording file is missing on disk.",
    )
  }

  if (precheck.action === "reuse") {
    await writeRecorderLog({
      level: "info",
      message: "Reusing existing recording for lead.",
      campaignLeadId: input.campaignLeadId,
      meta: {
        recordingId: precheck.recordingId,
        path: precheck.path,
      },
    })

    await linkRecordingToCampaignLead(input.campaignLeadId, precheck.recordingId)

    await insertEvent({
      campaignLeadId: input.campaignLeadId,
      kind: "note",
      step: "recording",
      message: "Reused existing website recording.",
      meta: {
        duration_ms: undefined,
      },
    })

    return "reuse"
  }

  if (precheck.action === "record_purged") {
    if (existing?.local_path != null) {
      const purgedPath = await purgeRow(precheck.recordingId)
      if (purgedPath) {
        await deleteContainedRelPath(purgedPath).catch(() => undefined)
      }
    }

    await insertEvent({
      campaignLeadId: input.campaignLeadId,
      kind: "note",
      step: "recording",
      message: PURGED_RERECORD_NOTE,
    })
  }

  return "capture"
}
