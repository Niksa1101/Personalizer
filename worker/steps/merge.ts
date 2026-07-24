import { abortableDelay, readStubStepMs } from "@/lib/pipeline-types"
import type { Step } from "./shared"

export const mergeStep: Step = {
  name: "merge",
  async run(ctx) {
    await abortableDelay(readStubStepMs(), ctx.signal)
  },
}
