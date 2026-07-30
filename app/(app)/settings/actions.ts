"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { verifySession } from "@/lib/dal"
import { CLEANUP_LOCK_KEY } from "@/worker/cleanup/job"
import { enqueueCleanup, getRedis } from "@/lib/queue"
import { upsertSettings } from "@/lib/settings-admin"
import {
  keysForGroup,
  SETTING_DEFAULTS,
  settingSchemaFor,
  type SettingGroup,
  type SettingKey,
} from "@/lib/settings-schema"

export type SettingsActionState = {
  error?: string
  fieldErrors?: Record<string, string>
  saved?: boolean
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

export async function updateSettingsGroupAction(
  group: SettingGroup,
  _prev: SettingsActionState,
  formData: FormData,
): Promise<SettingsActionState> {
  await verifySession()

  const keys = keysForGroup(group)
  const entries: Array<{ key: SettingKey; value: unknown }> = []
  const fieldErrors: Record<string, string> = {}

  for (const key of keys) {
    const rawValues = formData.getAll(key)
    if (rawValues.length === 0) continue
    if (rawValues.length > 1) {
      fieldErrors[key] = "Duplicate field values submitted"
      continue
    }

    const raw = rawValues[0]
    const schema = settingSchemaFor(key)
    const parsed = schema.safeParse(raw)
    if (!parsed.success) {
      Object.assign(fieldErrors, zodFieldErrors(parsed.error))
      continue
    }
    entries.push({ key, value: parsed.data })
  }

  if (Object.keys(fieldErrors).length > 0) {
    return { fieldErrors }
  }

  try {
    await upsertSettings(
      entries as Array<{
        key: SettingKey
        value: (typeof SETTING_DEFAULTS)[SettingKey]
      }>,
    )
    revalidatePath("/settings")
    return { saved: true }
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Failed to save settings",
    }
  }
}

const ENQUEUE_TIMEOUT_MS = 3_000

export async function runCleanupNowAction(): Promise<{
  ok: boolean
  message: string
}> {
  await verifySession()

  try {
    const lockPresent = await getRedis().get(CLEANUP_LOCK_KEY)
    if (lockPresent) {
      return { ok: false, message: "A cleanup is already running." }
    }
  } catch {
    // advisory only — proceed to enqueue
  }

  let timer: NodeJS.Timeout | undefined
  try {
    await Promise.race([
      enqueueCleanup(`cleanup-manual-${Date.now()}`, "manual"),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `Redis enqueue timed out after ${ENQUEUE_TIMEOUT_MS}ms`,
              ),
            ),
          ENQUEUE_TIMEOUT_MS,
        )
      }),
    ])
    revalidatePath("/settings")
    return { ok: true, message: "Cleanup queued." }
  } catch {
    return {
      ok: false,
      message: "Couldn't confirm — the job may still land.",
    }
  } finally {
    clearTimeout(timer)
  }
}
