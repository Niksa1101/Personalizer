import { readStubStepMs } from "@/lib/pipeline-env"
import {
  abortableDelay,
  PipelineStepError,
  ShutdownError,
} from "@/lib/pipeline-types"

import { insertPipelineEvent } from "../db"
import { runMerge } from "../video/merge"
import type { Step, StepContext } from "./shared"

export const mergeStep: Step = {
  name: "merge",
  async run(ctx: StepContext) {
    const stubMode = process.env.PIPELINE_STUB_STEP_MS != null
    if (stubMode) {
      await abortableDelay(readStubStepMs(), ctx.signal)
      return
    }

    try {
      const note = await runMerge(ctx)

      await insertPipelineEvent({
        campaignLeadId: ctx.lead.campaignLead.id,
        kind: "note",
        step: "merge",
        message: "Merge completed.",
        meta: note,
      })
    } catch (error) {
      if (error instanceof ShutdownError) {
        throw error
      }
      if (error instanceof PipelineStepError) {
        throw error
      }
      throw new PipelineStepError(
        "unknown",
        error instanceof Error ? error.message : String(error),
      )
    }
  },
}
