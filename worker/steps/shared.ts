import type { PipelineStep } from "@/lib/pipeline-types"
import type { JobSettings, LeadContext } from "../db"

export type StepContext = {
  lead: LeadContext
  settings: JobSettings
  signal: AbortSignal
  jobRunId: string
}

export type Step = {
  name: PipelineStep
  run(ctx: StepContext): Promise<void>
}
