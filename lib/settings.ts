import "server-only"

import { cache } from "react"

import {
  MERGE_LAYOUT_SET,
  SETTING_DEFAULTS,
  SETTING_KEYS,
  type MergeLayout,
  type SettingKey,
  type SettingValues,
} from "@/lib/settings-schema"
import { getSupabaseAdmin } from "@/lib/supabase"

export type { MergeLayout, SettingKey, SettingValues }
export { SETTING_DEFAULTS, SETTING_KEYS }

export type SettingOverrides<K extends SettingKey = SettingKey> = {
  campaign?: SettingValues[K] | null
  lead?: SettingValues[K] | null
}

// Range validation lives in lib/settings-schema.ts and runs on the write path only —
// corrupt jsonb falls back silently on read.
export function parseStoredSetting<K extends SettingKey>(
  key: K,
  raw: unknown,
): SettingValues[K] | undefined {
  switch (key) {
    case "recorder.viewport_width":
    case "recorder.viewport_height":
    case "recorder.nav_timeout_ms":
    case "recorder.scroll_ease_ms":
    case "recorder.post_load_delay_ms":
    case "recorder.retention_days":
    case "merge.pip_scale":
    case "merge.max_stretch_factor":
    case "encode.web_crf":
    case "encode.web_audio_kbps":
    case "encode.merge_timeout_ms":
    case "deploy.timeout_ms":
    case "queue.concurrency":
    case "queue.auto_retry_limit": {
      const value = typeof raw === "number" ? raw : Number(raw)
      return Number.isFinite(value) ? (value as SettingValues[K]) : undefined
    }
    case "merge.layout": {
      if (typeof raw === "string" && MERGE_LAYOUT_SET.has(raw as MergeLayout)) {
        return raw as SettingValues[K]
      }
      return undefined
    }
    case "deploy.dry_run": {
      if (typeof raw === "boolean") return raw as SettingValues[K]
      if (raw === "true") return true as SettingValues[K]
      if (raw === "false") return false as SettingValues[K]
      return undefined
    }
    default:
      return undefined
  }
}

const SETTINGS_TTL_MS = 5_000

let ttlSettings: Partial<SettingValues> | null = null
let ttlLoadedAt = 0

const loadGlobalSettingsCached = cache(async (): Promise<Partial<SettingValues>> => {
  const { data, error } = await getSupabaseAdmin()
    .from("settings")
    .select("key, value")

  if (error) {
    console.warn(`Failed to load settings: ${error.message}`)
    return {}
  }

  const resolved: Partial<SettingValues> = {}

  for (const row of data ?? []) {
    if (!SETTING_KEYS.includes(row.key as SettingKey)) continue
    const key = row.key as SettingKey
    const parsed = parseStoredSetting(key, row.value)
    if (parsed !== undefined) {
      Object.assign(resolved, { [key]: parsed })
    }
  }

  return resolved
})

async function loadGlobalSettings(): Promise<Partial<SettingValues>> {
  const now = Date.now()
  if (ttlSettings && now - ttlLoadedAt < SETTINGS_TTL_MS) {
    return ttlSettings
  }
  ttlSettings = await loadGlobalSettingsCached()
  ttlLoadedAt = now
  return ttlSettings
}

/** Resolve one key against an already-loaded global map — lead → campaign →
 *  global → seed default. Exported so a caller holding a `resolveMany()` result
 *  can apply per-row overrides without a round trip per row. */
export function resolveValue<K extends SettingKey>(
  key: K,
  global: Partial<SettingValues>,
  overrides?: SettingOverrides<K>,
): SettingValues[K] {
  if (overrides?.lead !== null && overrides?.lead !== undefined) {
    return overrides.lead
  }
  if (overrides?.campaign !== null && overrides?.campaign !== undefined) {
    return overrides.campaign
  }
  if (global[key] !== undefined) {
    return global[key]!
  }

  console.warn(
    `Setting "${key}" missing from DB — falling back to seed default`,
  )
  return SETTING_DEFAULTS[key]
}

export async function resolveSetting<K extends SettingKey>(
  key: K,
  overrides?: SettingOverrides<K>,
): Promise<SettingValues[K]> {
  const global = await loadGlobalSettings()
  return resolveValue(key, global, overrides)
}

export async function resolveMany<K extends SettingKey>(
  keys: readonly K[],
  overrides?: Partial<Record<K, SettingOverrides<K>>>,
): Promise<Pick<SettingValues, K>> {
  const global = await loadGlobalSettings()
  const result = {} as Pick<SettingValues, K>
  for (const key of keys) {
    result[key] = resolveValue(key, global, overrides?.[key])
  }
  return result
}

/** Test-only: clears the module-level TTL cache. */
export function resetSettingsTtlCache(): void {
  ttlSettings = null
  ttlLoadedAt = 0
}
