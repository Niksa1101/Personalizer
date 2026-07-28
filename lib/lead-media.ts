import "server-only"

import path from "node:path"

import { assertEnv } from "@/lib/env"
import { storageAbs } from "@/lib/storage"
import { getSupabaseAdmin } from "@/lib/supabase"

export function contentTypeFromExtension(filePath: string): string | null {
  const ext = path.extname(filePath).slice(1).toLowerCase()
  if (ext === "mp4") return "video/mp4"
  if (ext === "png") return "image/png"
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg"
  if (ext === "webp") return "image/webp"
  return null
}

export function assertPathContained(absPath: string): boolean {
  const root = path.resolve(assertEnv().LOCAL_STORAGE_ROOT)
  const resolved = path.resolve(absPath)
  const relative = path.relative(root, resolved)
  return relative !== ".." && !relative.startsWith(`..${path.sep}`)
}

export async function loadCampaignLeadMediaContext(campaignLeadId: string) {
  const { data, error } = await getSupabaseAdmin()
    .from("campaign_leads")
    .select(
      `
      id,
      recording_id,
      video_id,
      recordings (
        local_path,
        purged_at,
        screenshot_before_path,
        screenshot_after_path
      ),
      videos!campaign_leads_video_fk (
        web_public_url,
        web_path,
        master_path
      )
    `,
    )
    .eq("id", campaignLeadId)
    .maybeSingle()

  if (error) throw new Error(error.message)
  return data
}

export function resolveContainedLocalPath(
  relPath: string | null | undefined,
): string | null {
  if (!relPath) return null
  const abs = storageAbs(relPath)
  if (!assertPathContained(abs)) return null
  return abs
}
