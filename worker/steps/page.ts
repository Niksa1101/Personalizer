import {
  abortableDelay,
  PipelineStepError,
  readStubStepMs,
  ShutdownError,
} from "@/lib/pipeline-types"

import { insertPipelineEvent } from "../db"
import { runPageGenerate } from "../page/generate"
import type { Step, StepContext } from "./shared"

export const pageStep: Step = {
  name: "page",
  async run(ctx: StepContext) {
    const stubMode = process.env.PIPELINE_STUB_STEP_MS != null
    if (stubMode) {
      await abortableDelay(readStubStepMs(), ctx.signal)
      return
    }

    try {
      const note = await runPageGenerate(ctx)

      await insertPipelineEvent({
        campaignLeadId: ctx.lead.campaignLead.id,
        kind: "note",
        step: "page",
        message: "Landing page generated.",
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
