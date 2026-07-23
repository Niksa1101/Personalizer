"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { verifySession } from "@/lib/dal"
import {
  assignIntroSchema,
  renameIntroSchema,
} from "@/lib/intro-types"
import {
  assignIntroToCampaigns,
  deleteIntro,
  IntroInUseError,
  renameIntro,
} from "@/lib/intros"

export type IntroActionState = {
  error?: string
  fieldErrors?: Record<string, string>
}

function zodFieldErrors(error: z.ZodError): Record<string, string> {
  const fieldErrors: Record<string, string> = {}
  for (const issue of error.issues) {
    const key = issue.path[0]
    if (typeof key === "string" && !fieldErrors[key]) {
      fieldErrors[key] = issue.message
    }
  }
  return fieldErrors
}

function actionError(message: string): IntroActionState {
  return { error: message }
}

export async function renameIntroAction(
  _prev: IntroActionState,
  formData: FormData,
): Promise<IntroActionState> {
  await verifySession()

  const raw = {
    id: formData.get("id"),
    name: formData.get("name"),
  }

  let parsed
  try {
    parsed = renameIntroSchema.parse(raw)
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { fieldErrors: zodFieldErrors(error) }
    }
    throw error
  }

  try {
    await renameIntro(parsed.id, parsed.name)
    revalidatePath("/intros")
    return {}
  } catch (error) {
    return actionError(
      error instanceof Error ? error.message : "Failed to rename intro",
    )
  }
}

export async function deleteIntroAction(introId: string): Promise<IntroActionState> {
  await verifySession()

  try {
    await deleteIntro(introId)
    revalidatePath("/intros")
    return {}
  } catch (error) {
    if (error instanceof IntroInUseError) {
      return actionError(error.message)
    }
    return actionError(
      error instanceof Error ? error.message : "Failed to delete intro",
    )
  }
}

export async function assignIntroToCampaignsAction(
  introId: string,
  campaignIds: string[],
): Promise<IntroActionState> {
  await verifySession()

  let parsed
  try {
    parsed = assignIntroSchema.parse({ introId, campaignIds })
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { fieldErrors: zodFieldErrors(error) }
    }
    throw error
  }

  try {
    await assignIntroToCampaigns(parsed.introId, parsed.campaignIds)
    revalidatePath("/intros")
    revalidatePath("/campaigns")
    for (const campaignId of parsed.campaignIds) {
      revalidatePath(`/campaigns/${campaignId}`)
    }
    return {}
  } catch (error) {
    return actionError(
      error instanceof Error ? error.message : "Failed to assign intro",
    )
  }
}
