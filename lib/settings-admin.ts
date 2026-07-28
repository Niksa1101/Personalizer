import "server-only"

import {
  SETTING_DEFAULTS,
  SETTING_KEYS,
  type SettingKey,
  type SettingValues,
} from "@/lib/settings-schema"
import { settingSchemaFor } from "@/lib/settings-schema"
import { parseStoredSetting } from "@/lib/settings"
import { getSupabaseAdmin } from "@/lib/supabase"

export type SettingParseState = "ok" | "unparseable" | "out_of_range"

export type SettingRow = {
  key: SettingKey
  storedValue: unknown | null
  effectiveValue: SettingValues[SettingKey]
  presentInDb: boolean
  parseState: SettingParseState
  description: string | null
  updatedAt: string | null
}

function classifyParseState<K extends SettingKey>(
  key: K,
  raw: unknown,
): { parseState: SettingParseState; effectiveValue: SettingValues[K] } {
  const parsed = parseStoredSetting(key, raw)
  if (parsed === undefined) {
    return {
      parseState: "unparseable",
      effectiveValue: SETTING_DEFAULTS[key],
    }
  }

  const validated = settingSchemaFor(key).safeParse(parsed)
  if (!validated.success) {
    return {
      parseState: "out_of_range",
      effectiveValue: SETTING_DEFAULTS[key],
    }
  }

  return { parseState: "ok", effectiveValue: validated.data }
}

export async function listSettingRows(): Promise<SettingRow[]> {
  const { data, error } = await getSupabaseAdmin()
    .from("settings")
    .select("key, value, description, updated_at")

  if (error) {
    throw new Error(`Failed to load settings: ${error.message}`)
  }

  const byKey = new Map(
    (data ?? []).map((row) => [
      row.key,
      {
        value: row.value,
        description: row.description,
        updatedAt: row.updated_at,
      },
    ]),
  )

  return SETTING_KEYS.map((key) => {
    const row = byKey.get(key)
    const storedValue = row?.value ?? null
    const { parseState, effectiveValue } = classifyParseState(
      key,
      storedValue ?? undefined,
    )

    return {
      key,
      storedValue,
      effectiveValue,
      presentInDb: row != null,
      parseState,
      description: row?.description ?? null,
      updatedAt: row?.updatedAt ?? null,
    }
  })
}

export async function upsertSettings(
  entries: Array<{ key: SettingKey; value: SettingValues[SettingKey] }>,
): Promise<void> {
  if (entries.length === 0) return

  const { error } = await getSupabaseAdmin()
    .from("settings")
    .upsert(
      entries.map((entry) => ({
        key: entry.key,
        value: entry.value,
      })),
      { onConflict: "key" },
    )

  if (error) {
    throw new Error(`Failed to save settings: ${error.message}`)
  }
}
