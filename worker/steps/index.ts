import type { PipelineStep } from "@/lib/pipeline-types"

import { deployStep } from "./deploy"
import { mergeStep } from "./merge"
import { pageStep } from "./page"
import { recordStep } from "./record"
import type { Step } from "./shared"

export type { Step, StepContext } from "./shared"

export const STEP_BY_NAME: Record<PipelineStep, Step> = {
  recording: recordStep,
  merge: mergeStep,
  page: pageStep,
  deploy: deployStep,
}
