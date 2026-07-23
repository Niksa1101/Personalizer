import "server-only"

import { cache } from "react"

import { getSupabaseAdmin } from "@/lib/supabase"

export type MergeLayout =
  | "bubble_br"
  | "bubble_bl"
  | "bubble_tr"
  | "bubble_tl"
  | "rect_br"
  | "fullscreen_intro"

export type SettingKey =
  | "recorder.viewport_width"
  | "recorder.viewport_height"
  | "recorder.nav_timeout_ms"
  | "recorder.scroll_ease_ms"
  | "recorder.post_load_delay_ms"
  | "recorder.retention_days"
  | "merge.pip_scale"
  | "merge.layout"
  | "merge.max_stretch_factor"
  | "encode.web_crf"
  | "encode.web_audio_kbps"
  | "queue.concurrency"
  | "queue.auto_retry_limit"
  | "deploy.dry_run"

export type SettingValues = {
  "recorder.viewport_width": number
  "recorder.viewport_height": number
  "recorder.nav_timeout_ms": number
  "recorder.scroll_ease_ms": number
  "recorder.post_load_delay_ms": number
  "recorder.retention_days": number
  "merge.pip_scale": number
  "merge.layout": MergeLayout
  "merge.max_stretch_factor": number
  "encode.web_crf": number
  "encode.web_audio_kbps": number
  "queue.concurrency": number
  "queue.auto_retry_limit": number
  "deploy.dry_run": boolean
}

export const SETTING_KEYS = [
  "recorder.viewport_width",
  "recorder.viewport_height",
  "recorder.nav_timeout_ms",
  "recorder.scroll_ease_ms",
  "recorder.post_load_delay_ms",
  "recorder.retention_days",
  "merge.pip_scale",
  "merge.layout",
  "merge.max_stretch_factor",
  "encode.web_crf",
  "encode.web_audio_kbps",
  "queue.concurrency",
  "queue.auto_retry_limit",
  "deploy.dry_run",
] as const satisfies readonly SettingKey[]

/** Seed defaults from DB.md §5.12 — used when a key is absent from the DB. */
export const SETTING_DEFAULTS: SettingValues = {
  "recorder.viewport_width": 1920,
  "recorder.viewport_height": 1080,
  "recorder.nav_timeout_ms": 120_000,
  "recorder.scroll_ease_ms": 800,
  "recorder.post_load_delay_ms": 1500,
  "recorder.retention_days": 30,
  "merge.pip_scale": 0.2,
  "merge.layout": "bubble_br",
  "merge.max_stretch_factor": 2.5,
  "encode.web_crf": 28,
  "encode.web_audio_kbps": 96,
  "queue.concurrency": 1,
  "queue.auto_retry_limit": 2,
  "deploy.dry_run": false,
}

const MERGE_LAYOUTS = new Set<MergeLayout>([
  "bubble_br",
  "bubble_bl",
  "bubble_tr",
  "bubble_tl",
  "rect_br",
  "fullscreen_intro",
])

export type SettingOverrides<K extends SettingKey = SettingKey> = {
  campaign?: SettingValues[K] | null
  lead?: SettingValues[K] | null
}

function parseSettingValue<K extends SettingKey>(
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
    case "merge.max_stretch_factor":
    case "encode.web_crf":
    case "encode.web_audio_kbps":
    case "queue.concurrency":
    case "queue.auto_retry_limit": {
      const value = typeof raw === "number" ? raw : Number(raw)
      return Number.isFinite(value) ? (value as SettingValues[K]) : undefined
    }
    case "merge.pip_scale": {
      const value = typeof raw === "number" ? raw : Number(raw)
      return Number.isFinite(value) ? (value as SettingValues[K]) : undefined
    }
    case "merge.layout": {
      if (typeof raw === "string" && MERGE_LAYOUTS.has(raw as MergeLayout)) {
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

const loadGlobalSettings = cache(async (): Promise<Partial<SettingValues>> => {
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
    const parsed = parseSettingValue(key, row.value)
    if (parsed !== undefined) {
      Object.assign(resolved, { [key]: parsed })
    }
  }

  return resolved
})

function resolveValue<K extends SettingKey>(
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
  overrides?: SettingOverrides<K>,
): Promise<Pick<SettingValues, K>> {
  const global = await loadGlobalSettings()
  const result = {} as Pick<SettingValues, K>
  for (const key of keys) {
    result[key] = resolveValue(key, global, overrides)
  }
  return result
}
