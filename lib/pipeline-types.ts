import type { Database } from "@/lib/database.types"

export type PipelineStep = Database["public"]["Enums"]["pipeline_step"]
export type ErrorCode = Database["public"]["Enums"]["error_code"]
export type EventKind = Database["public"]["Enums"]["event_kind"]

export const PIPELINE_STEPS: readonly PipelineStep[] = [
  "recording",
  "merge",
  "page",
  "deploy",
] as const

/** Single source of truth for every `error_code` enum value. */
export const ERROR_CODES: readonly ErrorCode[] = [
  "dns_failure",
  "connection_refused",
  "ssl_error",
  "http_4xx",
  "http_5xx",
  "parked_domain",
  "empty_page",
  "not_a_website",
  "bot_detected",
  "captcha",
  "geo_blocked",
  "login_required",
  "nav_timeout",
  "browser_crash",
  "ffmpeg_failure",
  "intro_missing",
  "missing_asset",
  "storage_upload_failed",
  "netlify_failure",
  "disk_full",
  "unknown",
] as const

export type StepOutcome =
  | { kind: "done" }
  | { kind: "paused" }
  | { kind: "failed" }
  | { kind: "retry"; delayMs: number }
  | { kind: "shutdown" }
  | { kind: "gone" }

/** Thrown by stub steps (and real steps in Phases 8–11) on graceful shutdown. */
export class ShutdownError extends Error {
  constructor(message = "Worker shutting down") {
    super(message)
    this.name = "ShutdownError"
  }
}

/** Step failure carrying a database error_code. */
export class PipelineStepError extends Error {
  readonly code: ErrorCode

  constructor(code: ErrorCode, message?: string) {
    super(message ?? code)
    this.name = "PipelineStepError"
    this.code = code
  }
}

/** Structured extras on pipeline_events.meta — consumed by Phase 13 drawer. */
export type PipelineEventMeta = {
  attempt?: number
  duration_ms?: number
  from_step?: PipelineStep
  to_step?: PipelineStep
  stretch_factor?: number
  used_speed_floor?: boolean
  hold_ms?: number
  layout?: string
  pip_px?: number
  master_ms?: number
  web_ms?: number
  poster_ms?: number
  poster_uploaded?: boolean
  path?: string
  bytes?: number
  sha1_changed?: boolean
  poster?: boolean
  cta_dropped?: boolean
}

export function nextPipelineStep(step: PipelineStep): PipelineStep | null {
  const index = PIPELINE_STEPS.indexOf(step)
  if (index < 0 || index >= PIPELINE_STEPS.length - 1) return null
  return PIPELINE_STEPS[index + 1]!
}

export function readRetryBaseMs(): number {
  const raw = process.env.PIPELINE_RETRY_BASE_MS
  if (raw === undefined || raw === "") return 30_000
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30_000
}

export function readStubStepMs(): number {
  const raw = process.env.PIPELINE_STUB_STEP_MS
  if (raw === undefined || raw === "") return 500
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 500
}

export function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  if (signal.aborted) return Promise.reject(new ShutdownError())

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      resolve()
    }, ms)

    const onAbort = () => {
      clearTimeout(timer)
      signal.removeEventListener("abort", onAbort)
      reject(new ShutdownError())
    }

    signal.addEventListener("abort", onAbort)
  })
}
