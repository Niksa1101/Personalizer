import { stat } from "node:fs/promises"

import { removeFile } from "@/lib/local-file"
import {
  hostFromLead,
  parseStubFailureHost,
} from "@/lib/pipeline-retry"
import { readStubStepMs } from "@/lib/pipeline-env"
import {
  abortableDelay,
  PipelineStepError,
} from "@/lib/pipeline-types"
import {
  evaluateRecordingPrecheck,
  PURGED_RERECORD_NOTE,
} from "@/lib/recording-precheck"
import { resolveMany } from "@/lib/settings"
import { leadSlug } from "@/lib/slug"
import { storageAbs } from "@/lib/storage"

import {
  getUsableRecording,
  insertFailedRecording,
  insertPipelineEvent,
  insertRecording,
  linkRecordingToCampaignLead,
  purgeRecording,
  updateRecordingCapture,
  writeRecorderLog,
} from "../db"
import {
  CaptureFailedError,
  captureRecording,
  resolveWebsiteUrl,
} from "../recorder"
import type { Step, StepContext } from "./shared"

function batchFolder(sourceBatchId: string | null): string {
  return sourceBatchId ?? "no-batch"
}

function isForcedRerecord(ctx: StepContext): boolean {
  return ctx.lead.campaignLead.recording_id != null
}

export const recordStep: Step = {
  name: "recording",
  async run(ctx: StepContext) {
    const { lead, signal } = ctx
    const { campaignLead, campaign } = lead

    const host = hostFromLead(lead.lead.domain, lead.lead.website_url)

    // Stub mode (verify:worker): exercise the state machine without a real
    // capture. Signalled by PIPELINE_STUB_STEP_MS, which only the verification
    // harness sets — production and verify:record never do. Mirrors the Phase 7
    // stub: settle delay, honour fail-*.test injection, then succeed.
    const stubMode = process.env.PIPELINE_STUB_STEP_MS != null
    if (stubMode) {
      await abortableDelay(readStubStepMs(), signal)
    }

    const injected = parseStubFailureHost(host)
    if (injected) {
      throw new PipelineStepError(injected, `Stub failure injected for ${host}`)
    }

    if (stubMode) {
      return
    }

    const recorderSettings = await resolveMany(
      [
        "recorder.viewport_width",
        "recorder.viewport_height",
        "recorder.nav_timeout_ms",
        "recorder.scroll_ease_ms",
        "recorder.post_load_delay_ms",
      ],
      {
        "recorder.viewport_width": { campaign: campaign.viewport_width },
        "recorder.viewport_height": { campaign: campaign.viewport_height },
        "recorder.nav_timeout_ms": { campaign: campaign.nav_timeout_ms },
      },
    )

    const forcedRerecord = isForcedRerecord(ctx)
    const existing = await getUsableRecording(lead.lead.id)
    const precheck = await evaluateRecordingPrecheck({
      recording: existing,
      forcedRerecord,
      statFile: async (relPath) => {
        try {
          await stat(storageAbs(relPath))
          return { exists: true }
        } catch {
          return { exists: false }
        }
      },
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
        campaignLeadId: campaignLead.id,
        meta: {
          recordingId: precheck.recordingId,
          path: precheck.path,
        },
      })

      await linkRecordingToCampaignLead(campaignLead.id, precheck.recordingId)

      await insertPipelineEvent({
        campaignLeadId: campaignLead.id,
        kind: "note",
        step: "recording",
        message: "Reused existing website recording.",
        meta: {
          duration_ms: undefined,
        },
      })

      return
    }

    if (precheck.action === "record_purged") {
      const purgedPath = await purgeRecording(precheck.recordingId)
      if (purgedPath) {
        await removeFile(storageAbs(purgedPath)).catch(() => undefined)
      }

      await insertPipelineEvent({
        campaignLeadId: campaignLead.id,
        kind: "note",
        step: "recording",
        message: PURGED_RERECORD_NOTE,
      })
    }

    const slugValue = leadSlug(lead.lead)
    const batchId = batchFolder(lead.lead.source_batch_id)
    const url = resolveWebsiteUrl(lead.lead.website_url, lead.lead.domain)

    await writeRecorderLog({
      level: "info",
      message: "Starting website recording capture.",
      campaignLeadId: campaignLead.id,
      meta: { url, batchId, slug: slugValue },
    })

    try {
      const captured = await captureRecording({
        url,
        batchId,
        leadSlugValue: slugValue,
        viewportWidth: recorderSettings["recorder.viewport_width"],
        viewportHeight: recorderSettings["recorder.viewport_height"],
        navTimeoutMs: recorderSettings["recorder.nav_timeout_ms"],
        scrollEaseMs: recorderSettings["recorder.scroll_ease_ms"],
        postLoadDelayMs: recorderSettings["recorder.post_load_delay_ms"],
        signal,
      })

      if (forcedRerecord && existing) {
        // Forced re-record: refresh the single active row in place rather than
        // purge + insert. Atomic — no two-active `recordings_lead_active_uk`
        // conflict, and no window where a failed write deletes the freshly
        // captured file or leaves the lead with no usable recording. The file
        // path is deterministic per lead, so the capture already overwrote it.
        await updateRecordingCapture(existing.id, {
          localPath: captured.recordingRelPath,
          durationMs: captured.durationMs,
          width: captured.width,
          height: captured.height,
          pageHeightPx: captured.pageHeightPx,
          fileSizeBytes: captured.fileSizeBytes,
          screenshotBeforePath: captured.screenshotBeforeRelPath,
          screenshotAfterPath: captured.screenshotAfterRelPath,
        })
        await linkRecordingToCampaignLead(campaignLead.id, existing.id, {
          invalidateVideo: true,
        })
        await writeRecorderLog({
          level: "info",
          message: "Website recording capture succeeded (forced re-record).",
          campaignLeadId: campaignLead.id,
          meta: {
            recordingId: existing.id,
            duration_ms: captured.durationMs,
            page_height_px: captured.pageHeightPx,
            reused: false,
          },
        })
        return
      }

      let recordingId: string
      try {
        recordingId = await insertRecording({
          leadId: lead.lead.id,
          localPath: captured.recordingRelPath,
          durationMs: captured.durationMs,
          width: captured.width,
          height: captured.height,
          pageHeightPx: captured.pageHeightPx,
          fileSizeBytes: captured.fileSizeBytes,
          screenshotBeforePath: captured.screenshotBeforeRelPath,
          screenshotAfterPath: captured.screenshotAfterRelPath,
        })
      } catch (insertError) {
        await removeFile(storageAbs(captured.recordingRelPath)).catch(
          () => undefined,
        )

        const message =
          insertError instanceof Error
            ? insertError.message
            : String(insertError)

        if (message.includes("recordings_lead_active_uk")) {
          const winner = await getUsableRecording(lead.lead.id)
          if (winner?.local_path) {
            await linkRecordingToCampaignLead(campaignLead.id, winner.id)
            await writeRecorderLog({
              level: "info",
              message: "Lost recording insert race; reusing existing row.",
              campaignLeadId: campaignLead.id,
              meta: { recordingId: winner.id },
            })
            return
          }
        }

        throw insertError
      }

      await linkRecordingToCampaignLead(campaignLead.id, recordingId, {
        invalidateVideo: true,
      })

      await writeRecorderLog({
        level: "info",
        message: "Website recording capture succeeded.",
        campaignLeadId: campaignLead.id,
        meta: {
          recordingId,
          duration_ms: captured.durationMs,
          page_height_px: captured.pageHeightPx,
          reused: false,
        },
      })
    } catch (error) {
      if (error instanceof CaptureFailedError) {
        await insertFailedRecording({
          leadId: lead.lead.id,
          errorCode: error.code,
          screenshotBeforePath: error.screenshotBeforeRelPath,
          screenshotAfterPath: error.screenshotAfterRelPath,
        }).catch(() => undefined)

        await writeRecorderLog({
          level: "warn",
          message: `Recording classified failure: ${error.code}`,
          campaignLeadId: campaignLead.id,
          meta: { detail: error.message },
        })

        throw error
      }

      await writeRecorderLog({
        level: "error",
        message: "Unexpected recording failure.",
        campaignLeadId: campaignLead.id,
        meta: {
          error: error instanceof Error ? error.message : String(error),
        },
      })

      throw error
    }
  },
}
