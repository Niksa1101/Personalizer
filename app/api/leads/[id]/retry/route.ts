import { z } from "zod"

import { checkOrigin, unauthorizedResponse, verifySession } from "@/lib/dal"
import {
  PipelineControlError,
  retryCampaignLead,
} from "@/lib/pipeline-control"

export const runtime = "nodejs"

const pipelineStepSchema = z.enum(["recording", "merge", "page", "deploy"])

const retryBodySchema = z
  .object({
    mode: z.enum(["resume", "restart", "step"]),
    step: pipelineStepSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.mode === "step" && !value.step) {
      ctx.addIssue({
        code: "custom",
        message: "step is required when mode is step",
        path: ["step"],
      })
    }
  })

function jsonError(message: string, status: number): Response {
  return Response.json({ error: message }, { status })
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const originError = checkOrigin(request)
  if (originError) return originError

  try {
    await verifySession()
  } catch {
    return unauthorizedResponse()
  }

  const { id } = await context.params

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return jsonError("Invalid JSON body.", 400)
  }

  const parsed = retryBodySchema.safeParse(body)
  if (!parsed.success) {
    return jsonError(parsed.error.issues[0]?.message ?? "Invalid body.", 400)
  }

  try {
    await retryCampaignLead(id, parsed.data.mode, parsed.data.step)
  } catch (error) {
    if (error instanceof PipelineControlError) {
      return jsonError(error.message, error.status)
    }
    const message = error instanceof Error ? error.message : "Retry failed"
    return jsonError(message, 500)
  }

  return Response.json({ ok: true })
}
