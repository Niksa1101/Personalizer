"use server"

import { revalidatePath } from "next/cache"
import { isRedirectError } from "next/dist/client/components/redirect-error"
import { redirect } from "next/navigation"
import { z } from "zod"

import { verifySession } from "@/lib/dal"
import {
  archiveCampaign,
  createCampaign,
  createCampaignSchema,
  deleteCampaign,
  updateCampaignCta,
  updateCampaignCtaSchema,
  updateCampaignGeneral,
  updateCampaignGeneralSchema,
  updateCampaignMerge,
  updateCampaignMergeSchema,
  updateCampaignRecorder,
  updateCampaignRecorderSchema,
  updateCampaignTemplate,
  updateCampaignTemplateSchema,
  unarchiveCampaign,
} from "@/lib/campaigns"
import { requestSiteSync } from "@/lib/site-sync"

export type CampaignActionState = {
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

function actionError(message: string): CampaignActionState {
  return { error: message }
}

export async function createCampaignAction(
  _prev: CampaignActionState,
  formData: FormData,
): Promise<CampaignActionState> {
  await verifySession()

  const raw = {
    name: formData.get("name"),
    slug: formData.get("slug"),
    description: formData.get("description") || null,
  }

  let parsed
  try {
    parsed = createCampaignSchema.parse(raw)
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { fieldErrors: zodFieldErrors(error) }
    }
    throw error
  }

  try {
    const campaign = await createCampaign(parsed)
    revalidatePath("/campaigns")
    redirect(`/campaigns/${campaign.id}?toast=created`)
  } catch (error) {
    if (isRedirectError(error)) throw error
    return actionError(
      error instanceof Error ? error.message : "Failed to create campaign",
    )
  }
}

export async function updateCampaignGeneralAction(
  campaignId: string,
  _prev: CampaignActionState,
  formData: FormData,
): Promise<CampaignActionState> {
  await verifySession()

  const raw = {
    name: formData.get("name"),
    slug: formData.get("slug"),
    description: formData.get("description") || null,
  }

  let parsed
  try {
    parsed = updateCampaignGeneralSchema.parse(raw)
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { fieldErrors: zodFieldErrors(error) }
    }
    throw error
  }

  try {
    await updateCampaignGeneral(campaignId, parsed)
    revalidatePath("/campaigns")
    revalidatePath(`/campaigns/${campaignId}`)
    return {}
  } catch (error) {
    return actionError(
      error instanceof Error ? error.message : "Failed to update campaign",
    )
  }
}

export async function updateCampaignMergeAction(
  campaignId: string,
  _prev: CampaignActionState,
  formData: FormData,
): Promise<CampaignActionState> {
  await verifySession()

  const introRaw = formData.get("intro_video_id")
  const raw = {
    merge_layout: formData.get("merge_layout"),
    pip_scale: formData.get("pip_scale"),
    intro_video_id:
      introRaw === "" || introRaw === "none" ? null : introRaw,
  }

  let parsed
  try {
    parsed = updateCampaignMergeSchema.parse(raw)
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { fieldErrors: zodFieldErrors(error) }
    }
    throw error
  }

  try {
    // FK write only — resume/enqueue is Phase 7.
    await updateCampaignMerge(campaignId, parsed)
    revalidatePath(`/campaigns/${campaignId}`)
    return {}
  } catch (error) {
    return actionError(
      error instanceof Error ? error.message : "Failed to update merge settings",
    )
  }
}

export async function updateCampaignTemplateAction(
  campaignId: string,
  _prev: CampaignActionState,
  formData: FormData,
): Promise<CampaignActionState> {
  await verifySession()

  const raw = {
    landing_template: formData.get("landing_template"),
  }

  let parsed
  try {
    parsed = updateCampaignTemplateSchema.parse(raw)
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { fieldErrors: zodFieldErrors(error) }
    }
    throw error
  }

  try {
    await updateCampaignTemplate(campaignId, parsed)
    revalidatePath(`/campaigns/${campaignId}`)
    return {}
  } catch (error) {
    return actionError(
      error instanceof Error ? error.message : "Failed to save template",
    )
  }
}

export async function updateCampaignCtaAction(
  campaignId: string,
  _prev: CampaignActionState,
  formData: FormData,
): Promise<CampaignActionState> {
  await verifySession()

  const typeRaw = formData.get("cta_type")
  const labelRaw = formData.get("cta_label")
  const urlRaw = formData.get("cta_url")

  const raw = {
    cta_type: typeRaw === "" || typeRaw === "none" ? null : typeRaw,
    cta_label: labelRaw === "" ? null : labelRaw,
    cta_url: urlRaw === "" ? null : urlRaw,
  }

  let parsed
  try {
    parsed = updateCampaignCtaSchema.parse(raw)
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { fieldErrors: zodFieldErrors(error) }
    }
    throw error
  }

  try {
    await updateCampaignCta(campaignId, parsed)
    revalidatePath(`/campaigns/${campaignId}`)
    return {}
  } catch (error) {
    return actionError(
      error instanceof Error ? error.message : "Failed to update CTA",
    )
  }
}

export async function updateCampaignRecorderAction(
  campaignId: string,
  _prev: CampaignActionState,
  formData: FormData,
): Promise<CampaignActionState> {
  await verifySession()

  const raw = {
    viewport_width: formData.get("viewport_width"),
    viewport_height: formData.get("viewport_height"),
    nav_timeout_ms: formData.get("nav_timeout_ms"),
  }

  let parsed
  try {
    parsed = updateCampaignRecorderSchema.parse(raw)
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { fieldErrors: zodFieldErrors(error) }
    }
    throw error
  }

  try {
    await updateCampaignRecorder(campaignId, parsed)
    revalidatePath(`/campaigns/${campaignId}`)
    return {}
  } catch (error) {
    return actionError(
      error instanceof Error
        ? error.message
        : "Failed to update recorder settings",
    )
  }
}

export async function archiveCampaignAction(campaignId: string): Promise<void> {
  await verifySession()
  await archiveCampaign(campaignId)
  revalidatePath("/campaigns")
  revalidatePath(`/campaigns/${campaignId}`)
}

export async function unarchiveCampaignAction(
  campaignId: string,
): Promise<void> {
  await verifySession()
  await unarchiveCampaign(campaignId)
  revalidatePath("/campaigns")
  revalidatePath(`/campaigns/${campaignId}`)
}

export async function deleteCampaignAction(
  campaignId: string,
  removePages: boolean,
): Promise<void> {
  await verifySession()
  // The RPC writes a pending_site_sync marker in the same transaction as the
  // delete, so the sync cannot be lost. Redis is only the fast path here.
  await deleteCampaign(campaignId, !removePages)
  await requestSiteSync({ campaign_id: campaignId, remove_pages: removePages })

  revalidatePath("/campaigns")
  redirect("/campaigns?toast=deleted")
}
