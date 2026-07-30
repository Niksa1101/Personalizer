import { z } from "zod"

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
  | "encode.merge_timeout_ms"
  | "queue.concurrency"
  | "queue.auto_retry_limit"
  | "deploy.dry_run"
  | "deploy.timeout_ms"
  | "cleanup.enabled"
  | "cleanup.dry_run"
  | "cleanup.screenshot_retention_days"

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
  "encode.merge_timeout_ms": number
  "queue.concurrency": number
  "queue.auto_retry_limit": number
  "deploy.dry_run": boolean
  "deploy.timeout_ms": number
  "cleanup.enabled": boolean
  "cleanup.dry_run": boolean
  "cleanup.screenshot_retention_days": number
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
  "encode.merge_timeout_ms",
  "queue.concurrency",
  "queue.auto_retry_limit",
  "deploy.dry_run",
  "deploy.timeout_ms",
  "cleanup.enabled",
  "cleanup.dry_run",
  "cleanup.screenshot_retention_days",
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
  "encode.merge_timeout_ms": 1_800_000,
  "queue.concurrency": 1,
  "queue.auto_retry_limit": 2,
  "deploy.dry_run": false,
  "deploy.timeout_ms": 300_000,
  "cleanup.enabled": true,
  "cleanup.dry_run": false,
  "cleanup.screenshot_retention_days": 30,
}

export const MERGE_LAYOUTS = [
  "bubble_br",
  "bubble_bl",
  "bubble_tr",
  "bubble_tl",
  "rect_br",
  "fullscreen_intro",
] as const satisfies readonly MergeLayout[]

export type SettingGroup =
  | "Recorder"
  | "Merge"
  | "Encode"
  | "Queue"
  | "Deploy"
  | "Cleanup"

export const SETTING_GROUPS: SettingGroup[] = [
  "Recorder",
  "Merge",
  "Encode",
  "Queue",
  "Deploy",
  "Cleanup",
]

export type OverrideScope =
  | "Global only"
  | "Campaign"
  | "Campaign + lead"
  | "Lead"

export type SettingFieldMeta = {
  group: SettingGroup
  label: string
  type: "integer" | "number" | "boolean" | "enum"
  integer?: boolean
  min?: number
  max?: number
  enumValues?: readonly MergeLayout[]
  overrideScope: OverrideScope
}

export const SETTING_FIELDS: Record<SettingKey, SettingFieldMeta> = {
  "recorder.viewport_width": {
    group: "Recorder",
    label: "Viewport width",
    type: "integer",
    integer: true,
    min: 320,
    max: 3840,
    overrideScope: "Campaign",
  },
  "recorder.viewport_height": {
    group: "Recorder",
    label: "Viewport height",
    type: "integer",
    integer: true,
    min: 320,
    max: 2160,
    overrideScope: "Campaign",
  },
  "recorder.nav_timeout_ms": {
    group: "Recorder",
    label: "Navigation timeout (ms)",
    type: "integer",
    integer: true,
    min: 10_000,
    max: 600_000,
    overrideScope: "Campaign",
  },
  "recorder.scroll_ease_ms": {
    group: "Recorder",
    label: "Scroll ease (ms)",
    type: "integer",
    integer: true,
    min: 0,
    max: 5000,
    overrideScope: "Global only",
  },
  "recorder.post_load_delay_ms": {
    group: "Recorder",
    label: "Post-load delay (ms)",
    type: "integer",
    integer: true,
    min: 0,
    max: 30_000,
    overrideScope: "Global only",
  },
  "recorder.retention_days": {
    group: "Recorder",
    label: "Recording retention (days)",
    type: "integer",
    integer: true,
    min: 1,
    max: 365,
    overrideScope: "Global only",
  },
  "merge.pip_scale": {
    group: "Merge",
    label: "PiP scale",
    type: "number",
    min: 0.05,
    max: 0.6,
    overrideScope: "Campaign + lead",
  },
  "merge.layout": {
    group: "Merge",
    label: "Merge layout",
    type: "enum",
    enumValues: MERGE_LAYOUTS,
    overrideScope: "Lead",
  },
  "merge.max_stretch_factor": {
    group: "Merge",
    label: "Max stretch factor",
    type: "number",
    min: 1.0,
    max: 5.0,
    overrideScope: "Global only",
  },
  "encode.web_crf": {
    group: "Encode",
    label: "Web CRF",
    type: "integer",
    integer: true,
    min: 0,
    max: 51,
    overrideScope: "Global only",
  },
  "encode.web_audio_kbps": {
    group: "Encode",
    label: "Web audio (kbps)",
    type: "integer",
    integer: true,
    min: 32,
    max: 320,
    overrideScope: "Global only",
  },
  "encode.merge_timeout_ms": {
    group: "Encode",
    label: "Merge timeout (ms)",
    type: "integer",
    integer: true,
    min: 60_000,
    max: 7_200_000,
    overrideScope: "Global only",
  },
  "queue.concurrency": {
    group: "Queue",
    label: "Worker concurrency",
    type: "integer",
    integer: true,
    min: 1,
    max: 4,
    overrideScope: "Global only",
  },
  "queue.auto_retry_limit": {
    group: "Queue",
    label: "Auto-retry limit",
    type: "integer",
    integer: true,
    min: 0,
    max: 9,
    overrideScope: "Global only",
  },
  "deploy.dry_run": {
    group: "Deploy",
    label: "Dry run",
    type: "boolean",
    overrideScope: "Global only",
  },
  "deploy.timeout_ms": {
    group: "Deploy",
    label: "Deploy timeout (ms)",
    type: "integer",
    integer: true,
    min: 30_000,
    max: 1_800_000,
    overrideScope: "Global only",
  },
  "cleanup.enabled": {
    group: "Cleanup",
    label: "Run daily cleanup",
    type: "boolean",
    overrideScope: "Global only",
  },
  "cleanup.dry_run": {
    group: "Cleanup",
    label: "Dry run",
    type: "boolean",
    overrideScope: "Global only",
  },
  "cleanup.screenshot_retention_days": {
    group: "Cleanup",
    label: "Screenshot retention (days)",
    type: "integer",
    integer: true,
    min: 1,
    max: 365,
    overrideScope: "Global only",
  },
}

/**
 * Boolean settings round-trip as jsonb booleans. Form posts submit strings.
 * z.coerce.boolean() is wrong: Boolean("false") === true.
 * z.stringbool() is also wrong: accepts "1"/"yes"/"on" and rejects real booleans.
 */
const BOOLEAN_SETTING = z.union([
  z.boolean(),
  z.literal("true").transform(() => true),
  z.literal("false").transform(() => false),
])

export function settingSchemaFor<K extends SettingKey>(
  key: K,
): z.ZodType<SettingValues[K]> {
  const meta = SETTING_FIELDS[key]

  switch (meta.type) {
    case "boolean":
      return BOOLEAN_SETTING as unknown as z.ZodType<SettingValues[K]>
    case "enum":
      return z.enum(
        MERGE_LAYOUTS as unknown as [MergeLayout, ...MergeLayout[]],
      ) as unknown as z.ZodType<SettingValues[K]>
    case "integer": {
      let schema = z.coerce.number()
      if (meta.min != null) schema = schema.min(meta.min)
      if (meta.max != null) schema = schema.max(meta.max)
      return schema.int() as unknown as z.ZodType<SettingValues[K]>
    }
    case "number": {
      let schema = z.coerce.number()
      if (meta.min != null) schema = schema.min(meta.min)
      if (meta.max != null) schema = schema.max(meta.max)
      return schema as unknown as z.ZodType<SettingValues[K]>
    }
    default:
      throw new Error(`Unknown setting type for ${key}`)
  }
}

export function keysForGroup(group: SettingGroup): SettingKey[] {
  return SETTING_KEYS.filter((key) => SETTING_FIELDS[key].group === group)
}

export const MERGE_LAYOUT_SET = new Set<MergeLayout>(MERGE_LAYOUTS)
