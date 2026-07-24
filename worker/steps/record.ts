import { abortableDelay, readStubStepMs } from "@/lib/pipeline-types"
import {
  hostFromLead,
  parseStubFailureHost,
} from "@/lib/pipeline-retry"
import { PipelineStepError } from "@/lib/pipeline-types"
import type { Step, StepContext } from "./shared"

export const recordStep: Step = {
  name: "recording",
  async run(ctx: StepContext) {
    await abortableDelay(readStubStepMs(), ctx.signal)

    const host = hostFromLead(ctx.lead.lead.domain, ctx.lead.lead.website_url)
    const injected = parseStubFailureHost(host)
    if (injected) {
      throw new PipelineStepError(injected, `Stub failure injected for ${host}`)
    }
  },
}
