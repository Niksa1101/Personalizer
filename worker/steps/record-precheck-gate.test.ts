import { strict as assert } from "node:assert"
import { describe, it } from "node:test"

import { PipelineStepError } from "@/lib/pipeline-types"
import { PURGED_RERECORD_NOTE } from "@/lib/recording-precheck"

import { runRecordPrecheckGate } from "./record-precheck-gate"

describe("runRecordPrecheckGate", () => {
  it("throws missing_asset when file is gone and row is not purged", async () => {
    await assert.rejects(
      () =>
        runRecordPrecheckGate({
          campaignLeadId: "cl-1",
          leadId: "lead-1",
          forcedRerecord: false,
          recording: {
            id: "rec-missing",
            local_path: "batch/acme/recording.mp4",
            purged_at: null,
          },
          statFile: async () => ({ exists: false }),
        }),
      (error: unknown) => {
        assert.ok(error instanceof PipelineStepError)
        assert.equal(error.code, "missing_asset")
        return true
      },
    )
  })

  it("returns capture and writes note without purge when already purged", async () => {
    let purgeCalls = 0
    let noteMessage: string | undefined

    const result = await runRecordPrecheckGate({
      campaignLeadId: "cl-purged",
      leadId: "lead-purged",
      forcedRerecord: false,
      recording: {
        id: "rec-purged",
        local_path: null,
        purged_at: "2026-01-01T00:00:00Z",
      },
      deps: {
        purgeRecording: async () => {
          purgeCalls += 1
          return null
        },
        insertPipelineEvent: async (event) => {
          noteMessage = event.message
        },
      },
    })

    assert.equal(result, "capture")
    assert.equal(purgeCalls, 0)
    assert.equal(noteMessage, PURGED_RERECORD_NOTE)
  })
})
