import { readFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"

import { assertEnv } from "@/lib/env"
import { PipelineStepError } from "@/lib/pipeline-types"
import { getSupabaseAdmin } from "@/lib/supabase"

import {
  reserveVideoStorageKey,
  updateVideoPosterUpload,
  updateVideoUpload,
  writeStepLog,
} from "../db"

const BUCKET = "lead-videos"

export function buildPublicUrl(storageKey: string): string {
  const base = assertEnv().NEXT_PUBLIC_SUPABASE_URL.replace(/\/$/, "")
  return `${base}/storage/v1/object/public/${BUCKET}/${storageKey}`
}

/** Derive `{prefix}/poster.jpg` from `{prefix}/final.mp4` (D9). */
export function derivePosterStorageKey(webStorageKey: string): string {
  const posterKey = webStorageKey.replace(/\/final\.mp4$/, "/poster.jpg")
  if (posterKey === webStorageKey) {
    throw new Error(
      `Cannot derive poster storage key from web storage key: ${webStorageKey}`,
    )
  }
  return posterKey
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

  const publicUrl = buildPublicUrl(storageKey)
  await updateVideoUpload({
    campaignLeadId: input.campaignLeadId,
    webPublicUrl: publicUrl,
  })

  return { storageKey, publicUrl }
}

export async function uploadPosterImage(input: {
  campaignLeadId: string
  posterAbsPath: string
  jobRunId: string
  webStorageKey: string | null
}): Promise<string> {
  let webKey = input.webStorageKey
  if (!webKey) {
    webKey = `${randomUUID()}/final.mp4`
    await reserveVideoStorageKey({
      campaignLeadId: input.campaignLeadId,
      webStorageKey: webKey,
    })
  }

  const posterKey = derivePosterStorageKey(webKey)
  const body = await readFile(input.posterAbsPath)

  const { error: uploadError } = await getSupabaseAdmin()
    .storage.from(BUCKET)
    .upload(posterKey, body, {
      contentType: "image/jpeg",
      cacheControl: "31536000",
      upsert: true,
    })

  if (uploadError) {
    throw new PipelineStepError(
      "storage_upload_failed",
      uploadError.message,
    )
  }

  await updateVideoPosterUpload({
    campaignLeadId: input.campaignLeadId,
    posterStorageKey: posterKey,
  })

  return posterKey
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
