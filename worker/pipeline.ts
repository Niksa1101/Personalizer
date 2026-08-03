import type { Job } from "bullmq"

import { mergePrecondition } from "@/lib/pipeline-preconditions"
import {
  backoffMs,
  classifyFailure,
} from "@/lib/pipeline-retry"
import {
  nextPipelineStep,
  PipelineStepError,
  ShutdownError,
  type PipelineStep,
  type StepOutcome,
} from "@/lib/pipeline-types"
import { resolveMany } from "@/lib/settings"
import { SiteOwnershipError } from "@/worker/deploy/ownership"

import {
  claimLead,
  checkUsableRecording,
  closeJobRun,
  insertPipelineEvent,
  loadLeadBase,
  markLeadFailed,
  markLeadPaused,
  openJobRun,
  reloadCampaignLead,
  scheduleRetry,
  setCurrentStep,
  updateLeadAfterStepSuccess,
  writeWorkerLog,
  type JobSettings,
  type LeadBase,
  type LeadContext,
} from "./db"
import { STEP_BY_NAME } from "./steps"

export type ProcessLeadOptions = {
  workerId: string
  signal: AbortSignal
}

export async function processLeadJob(
  job: Job<{ campaignLeadId: string }>,
  opts: ProcessLeadOptions,
): Promise<StepOutcome> {
  const campaignLeadId = job.data.campaignLeadId

  const claimed = await claimLead(campaignLeadId)
  if (claimed === "gone") {
    await writeWorkerLog({
      level: "info",
      message: "Campaign lead deleted mid-flight; completing job.",
      meta: { campaignLeadId },
    })
    return { kind: "gone" }
  }
  if (claimed === "skipped") {
    return { kind: "done" }
  }

  const base = await loadLeadBase(campaignLeadId)
  if (!base) {
    await writeWorkerLog({
      level: "info",
      message: "Campaign lead deleted mid-flight; completing job.",
      meta: { campaignLeadId },
    })
    return { kind: "gone" }
  }

  const settings = await resolveMany(["queue.auto_retry_limit"])
  const jobSettings: JobSettings = {
    autoRetryLimit: settings["queue.auto_retry_limit"],
  }

  return walkSteps({
    base,
    job,
    jobSettings,
    opts,
  })
}

async function walkSteps(input: {
  base: LeadBase
  job: Job<{ campaignLeadId: string }>
  jobSettings: JobSettings
  opts: ProcessLeadOptions
}): Promise<StepOutcome> {
  const { base, job, jobSettings, opts } = input
  let campaignLead = base.campaignLead
  let step = campaignLead.current_step as PipelineStep
  let redirectedToRecording = false

  while (true) {
    let hasUsableRecording = false

    if (step === "merge") {
      hasUsableRecording = await checkUsableRecording(base.lead.id)
      const precondition = mergePrecondition({
        hasIntro: base.campaign.intro_video_id != null,
        hasUsableRecording,
        alreadyRedirected: redirectedToRecording,
      })

      if (precondition === "pause_intro_missing") {
        // Events first, status last (Tech.md §6 / plan §4.2).
        await insertPipelineEvent({
          campaignLeadId: campaignLead.id,
          kind: "paused",
          step: "merge",
          message: "Paused at merge — campaign has no intro video.",
          errorCode: "intro_missing",
        })
        await markLeadPaused({ campaignLeadId: campaignLead.id })
        return { kind: "paused" }
      }

      if (precondition === "record_first") {
        redirectedToRecording = true
        await setCurrentStep(campaignLead.id, "recording")
        await insertPipelineEvent({
          campaignLeadId: campaignLead.id,
          kind: "note",
          step: "merge",
          message:
            "No usable recording found; returning to recording before merge.",
          meta: { from_step: "merge", to_step: "recording" },
        })
        step = "recording"
        const reloaded = await reloadCampaignLead(campaignLead.id)
        if (!reloaded) return { kind: "gone" }
        campaignLead = reloaded
        continue
      }
    }

    const context: LeadContext = {
      campaignLead,
      campaign: base.campaign,
      lead: base.lead,
      hasUsableRecording,
    }

    const stepResult = await runOneStep({
      context,
      step,
      job,
      jobSettings,
      opts,
    })

    if (stepResult.outcome) {
      return stepResult.outcome
    }

    const nextStep = nextPipelineStep(step)
    if (!nextStep) {
      return { kind: "done" }
    }

    await updateLeadAfterStepSuccess({
      campaignLeadId: campaignLead.id,
      nextStep,
    })

    step = nextStep
    const reloaded = await reloadCampaignLead(campaignLead.id)
    if (!reloaded) return { kind: "gone" }
    campaignLead = reloaded
  }
}

async function runOneStep(input: {
  context: LeadContext
  step: PipelineStep
  job: Job<{ campaignLeadId: string }>
  jobSettings: JobSettings
  opts: ProcessLeadOptions
}): Promise<{ outcome?: StepOutcome }> {
  const { context, step, job, jobSettings, opts } = input
  const attempt = context.campaignLead.attempt_count + 1
  const startedAt = Date.now()

  const jobRunId = await openJobRun({
    campaignLeadId: context.campaignLead.id,
    step,
    attempt,
    queueJobId: job.id ?? context.campaignLead.id,
    workerId: opts.workerId,
  })

  await insertPipelineEvent({
    campaignLeadId: context.campaignLead.id,
    kind: "step_started",
    step,
    message: `Started ${step}.`,
    meta: { attempt },
  })

  try {
    await STEP_BY_NAME[step].run({
      lead: context,
      settings: jobSettings,
      signal: opts.signal,
      jobRunId,
    })
  } catch (error) {
    if (error instanceof ShutdownError) {
      return { outcome: { kind: "shutdown" } }
    }

    if (error instanceof SiteOwnershipError) {
      const detail = error.message
      await closeJobRun(jobRunId, "failed", { code: "unknown", detail })
      await insertPipelineEvent({
        campaignLeadId: context.campaignLead.id,
        kind: "step_failed",
        step,
        message: `${step} failed: ${detail}`,
        errorCode: "unknown",
        meta: { attempt },
      })
      await markLeadFailed({
        campaignLeadId: context.campaignLead.id,
        errorCode: "unknown",
        errorDetail: detail,
      })
      return { outcome: { kind: "failed" } }
    }

    const code =
      error instanceof PipelineStepError ? error.code : ("unknown" as const)
    const detail =
      error instanceof Error ? error.message : "Unknown pipeline error"

    if (classifyFailure(code) === "terminal") {
      await closeJobRun(jobRunId, "failed", { code, detail })
      await insertPipelineEvent({
        campaignLeadId: context.campaignLead.id,
        kind: "step_failed",
        step,
        message: `${step} failed: ${detail}`,
        errorCode: code,
        meta: { attempt },
      })
      await markLeadFailed({
        campaignLeadId: context.campaignLead.id,
        errorCode: code,
        errorDetail: detail,
      })
      return { outcome: { kind: "failed" } }
    }

    const nextAttemptCount = context.campaignLead.attempt_count + 1
    if (nextAttemptCount > jobSettings.autoRetryLimit) {
      await closeJobRun(jobRunId, "failed", { code, detail })
      await insertPipelineEvent({
        campaignLeadId: context.campaignLead.id,
        kind: "step_failed",
        step,
        message: `${step} failed after retries: ${detail}`,
        errorCode: code,
        meta: { attempt },
      })
      await markLeadFailed({
        campaignLeadId: context.campaignLead.id,
        errorCode: code,
        errorDetail: detail,
      })
      return { outcome: { kind: "failed" } }
    }

    await closeJobRun(jobRunId, "failed", { code, detail })
    await insertPipelineEvent({
      campaignLeadId: context.campaignLead.id,
      kind: "retry_scheduled",
      step,
      message: `Retry scheduled for ${step} (attempt ${nextAttemptCount}).`,
      errorCode: code,
      meta: { attempt: nextAttemptCount },
    })
    await scheduleRetry({
      campaignLeadId: context.campaignLead.id,
      attemptCount: nextAttemptCount,
      step,
      errorCode: code,
      errorDetail: detail,
    })

    return {
      outcome: {
        kind: "retry",
        delayMs: backoffMs(nextAttemptCount),
      },
    }
  }

  const durationMs = Date.now() - startedAt
  await closeJobRun(jobRunId, "succeeded")
  await insertPipelineEvent({
    campaignLeadId: context.campaignLead.id,
    kind: "step_succeeded",
    step,
    message: `Completed ${step}.`,
    meta: { attempt, duration_ms: durationMs },
  })

  return {}
}
