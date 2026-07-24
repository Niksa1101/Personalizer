import { abortableDelay, readStubStepMs } from "@/lib/pipeline-types"
import type { Step } from "./shared"

export const pageStep: Step = {
  name: "page",
  async run(ctx) {
    await abortableDelay(readStubStepMs(), ctx.signal)
  },
}
