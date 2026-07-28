"use server"

import { revalidatePath } from "next/cache"
import { z } from "zod"

import { verifySession } from "@/lib/dal"
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
