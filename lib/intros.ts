import "server-only"

import type { IntroVideoRow } from "@/lib/intro-types"
import type { Json } from "@/lib/database.types"
import { getSupabaseAdmin } from "@/lib/supabase"

export type { IntroVideoRow } from "@/lib/intro-types"

export type IntroWithUsage = IntroVideoRow & {
  campaigns: { id: string; name: string }[]
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
