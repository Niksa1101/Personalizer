import { abortableDelay, readStubStepMs } from "@/lib/pipeline-types"
import type { Step } from "./shared"

export const deployStep: Step = {
  name: "deploy",
  async run(ctx) {
    await abortableDelay(readStubStepMs(), ctx.signal)
  },
}
