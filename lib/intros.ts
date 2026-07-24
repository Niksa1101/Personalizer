import "server-only"

import type { IntroVideoRow } from "@/lib/intro-types"
import { reconcileIntroCampaignSelection } from "@/lib/intro-types"
import { resumePausedLeadsForCampaigns } from "@/lib/pipeline-control"
import type { Json } from "@/lib/database.types"
import { removeIfExists } from "@/lib/local-file"
import { introPosterRelPath, introRelPath, storageAbs } from "@/lib/storage"
import { getSupabaseAdmin } from "@/lib/supabase"

export type { IntroVideoRow } from "@/lib/intro-types"

export type IntroWithUsage = IntroVideoRow & {
  campaigns: { id: string; name: string }[]
}

export type AssignableCampaign = {
  id: string
  name: string
  intro_video_id: string | null
}

export class IntroInUseError extends Error {
  readonly campaigns: { id: string; name: string }[]

  constructor(campaigns: { id: string; name: string }[]) {
    super(
      `This intro is used by ${campaigns.map((c) => c.name).join(", ")}. Remove it from those campaigns before deleting.`,
    )
    this.name = "IntroInUseError"
    this.campaigns = campaigns
  }
}

export type InsertIntroInput = {
  id: string
  name: string
  local_path: string
  original_filename: string | null
  duration_ms: number
  width: number
  height: number
  fps: number
  file_size_bytes: number | null
  poster_path: string | null
}

export async function insertIntro(input: InsertIntroInput): Promise<IntroVideoRow> {
  const { data, error } = await getSupabaseAdmin()
    .from("intro_videos")
    .insert(input)
    .select("*")
    .single()

  if (error) throw new Error(`Failed to insert intro video: ${error.message}`)
  return data
}

export async function getIntro(id: string): Promise<IntroVideoRow | null> {
  const { data, error } = await getSupabaseAdmin()
    .from("intro_videos")
    .select("*")
    .eq("id", id)
    .maybeSingle()

  if (error) throw new Error(`Failed to fetch intro video: ${error.message}`)
  return data
}

export async function campaignsUsingIntro(
  introId: string,
): Promise<{ id: string; name: string }[]> {
  const { data, error } = await getSupabaseAdmin()
    .from("campaigns")
    .select("id, name")
    .eq("intro_video_id", introId)
    .order("name")

  if (error) {
    throw new Error(`Failed to list campaigns using intro: ${error.message}`)
  }

  return data ?? []
}

export async function listIntrosWithUsage(): Promise<IntroWithUsage[]> {
  const { data: intros, error } = await getSupabaseAdmin()
    .from("intro_videos")
    .select("*")
    .order("created_at", { ascending: false })

  if (error) throw new Error(`Failed to list intro videos: ${error.message}`)

  const { data: campaigns, error: campaignsError } = await getSupabaseAdmin()
    .from("campaigns")
    .select("id, name, intro_video_id")
    .not("intro_video_id", "is", null)

  if (campaignsError) {
    throw new Error(`Failed to list intro campaign usage: ${campaignsError.message}`)
  }

  const byIntro = new Map<string, { id: string; name: string }[]>()
  for (const campaign of campaigns ?? []) {
    if (!campaign.intro_video_id) continue
    const list = byIntro.get(campaign.intro_video_id) ?? []
    list.push({ id: campaign.id, name: campaign.name })
    byIntro.set(campaign.intro_video_id, list)
  }

  return (intros ?? []).map((intro) => ({
    ...intro,
    campaigns: byIntro.get(intro.id) ?? [],
  }))
}

export async function listAssignableCampaigns(): Promise<AssignableCampaign[]> {
  const { data, error } = await getSupabaseAdmin()
    .from("campaigns")
    .select("id, name, intro_video_id")
    .is("archived_at", null)
    .order("name")

  if (error) {
    throw new Error(`Failed to list assignable campaigns: ${error.message}`)
  }

  return data ?? []
}

export async function renameIntro(id: string, name: string): Promise<IntroVideoRow> {
  const { data, error } = await getSupabaseAdmin()
    .from("intro_videos")
    .update({ name })
    .eq("id", id)
    .select("*")
    .single()

  if (error) throw new Error(`Failed to rename intro video: ${error.message}`)
  return data
}

export async function setIntroCampaigns(
  introId: string,
  selectedIds: string[],
): Promise<string[]> {
  const presented = await listAssignableCampaigns()
  const presentedIds = presented.map((campaign) => campaign.id)
  const { selected, deselected } = reconcileIntroCampaignSelection(
    presentedIds,
    selectedIds,
  )

  // Two sequential updates — no cross-statement transaction (consistent with other app writes).
  if (selected.length > 0) {
    const { error } = await getSupabaseAdmin()
      .from("campaigns")
      .update({ intro_video_id: introId })
      .in("id", selected)

    if (error) {
      throw new Error(`Failed to assign intro to campaigns: ${error.message}`)
    }

    try {
      await resumePausedLeadsForCampaigns(selected)
    } catch (resumeError) {
      console.error("Failed to resume paused leads after intro assignment:", resumeError)
      const { error: logError } = await getSupabaseAdmin().from("logs").insert({
        level: "error",
        scope: "web",
        message: "Failed to resume paused leads after intro assignment",
        meta: {
          introId,
          campaignIds: selected,
          error:
            resumeError instanceof Error
              ? resumeError.message
              : String(resumeError),
        },
      })
      if (logError) {
        console.error("Failed to write intro resume log:", logError.message)
      }
    }
  }

  if (deselected.length > 0) {
    const { error } = await getSupabaseAdmin()
      .from("campaigns")
      .update({ intro_video_id: null })
      .in("id", deselected)
      .eq("intro_video_id", introId)

    if (error) {
      throw new Error(`Failed to clear intro from campaigns: ${error.message}`)
    }
  }

  return [...new Set([...selected, ...deselected])]
}

export async function deleteIntro(id: string): Promise<void> {
  const campaigns = await campaignsUsingIntro(id)
  if (campaigns.length > 0) {
    throw new IntroInUseError(campaigns)
  }

  const intro = await getIntro(id)
  if (!intro) return

  await removeIfExists(storageAbs(intro.local_path))
  if (intro.poster_path) {
    await removeIfExists(storageAbs(intro.poster_path))
  }

  const { error } = await getSupabaseAdmin()
    .from("intro_videos")
    .delete()
    .eq("id", id)

  if (error) throw new Error(`Failed to delete intro video: ${error.message}`)

  await getSupabaseAdmin()
    .from("logs")
    .insert({
      level: "info",
      scope: "web",
      message: "Intro deleted",
      meta: { introId: id, name: intro.name } as Json,
    })
}

export function introAssetPaths(id: string): {
  video: string
  poster: string
} {
  return {
    video: introRelPath(id),
    poster: introPosterRelPath(id),
  }
}

export async function writeWebLog(
  message: string,
  meta: Json = {},
): Promise<void> {
  const { error } = await getSupabaseAdmin().from("logs").insert({
    level: "error",
    scope: "web",
    message,
    meta,
  })

  if (error) {
    console.error("Failed to write web log:", error.message)
  }
}
