import { readFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"

import { assertEnv } from "@/lib/env"
import { PipelineStepError } from "@/lib/pipeline-types"
import { getSupabaseAdmin } from "@/lib/supabase"

import { reserveVideoStorageKey, updateVideoUpload, writeStepLog } from "../db"

const BUCKET = "lead-videos"

export function buildWebPublicUrl(storageKey: string): string {
  const base = assertEnv().NEXT_PUBLIC_SUPABASE_URL.replace(/\/$/, "")
  return `${base}/storage/v1/object/public/${BUCKET}/${storageKey}`
}

export async function uploadWebVideo(input: {
  campaignLeadId: string
  webAbsPath: string
  jobRunId: string
  reservedKey: string | null
}): Promise<{ storageKey: string; publicUrl: string }> {
  let storageKey = input.reservedKey
  if (!storageKey) {
    storageKey = `${randomUUID()}/final.mp4`
    await reserveVideoStorageKey({
      campaignLeadId: input.campaignLeadId,
      webStorageKey: storageKey,
    })
  }

  const body = await readFile(input.webAbsPath)

  const { error: uploadError } = await getSupabaseAdmin()
    .storage.from(BUCKET)
    .upload(storageKey, body, {
      contentType: "video/mp4",
      cacheControl: "31536000",
      upsert: true,
    })

  if (uploadError) {
    throw new PipelineStepError(
      "storage_upload_failed",
      uploadError.message,
    )
  }

  const publicUrl = buildWebPublicUrl(storageKey)
  await updateVideoUpload({
    campaignLeadId: input.campaignLeadId,
    webPublicUrl: publicUrl,
  })

  return { storageKey, publicUrl }
}

export async function deleteStorageObject(
  storageKey: string,
  input: { campaignLeadId: string; jobRunId: string },
): Promise<void> {
  const { error } = await getSupabaseAdmin()
    .storage.from(BUCKET)
    .remove([storageKey])

  if (error) {
    await writeStepLog({
      scope: "merger",
      level: "warn",
      message: `Failed to delete storage object: ${storageKey}`,
      campaignLeadId: input.campaignLeadId,
      jobRunId: input.jobRunId,
      meta: { error: error.message },
    })
  }
}
