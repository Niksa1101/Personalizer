import { ERROR_CODES, type ErrorCode } from "@/lib/pipeline-types"
import { readRetryBaseMs } from "@/lib/pipeline-types"

/**
 * Mirrors `error_code_bucket()` bad_website list in
 * supabase/migrations/20260720120200_functions.sql:75.
 */
export const BAD_WEBSITE_CODES = new Set<ErrorCode>([
  "dns_failure",
  "connection_refused",
  "ssl_error",
  "http_4xx",
  "http_5xx",
  "parked_domain",
  "empty_page",
  "not_a_website",
])

export type FailureClassification = "terminal" | "retryable"

export function classifyFailure(code: ErrorCode): FailureClassification {
  if (BAD_WEBSITE_CODES.has(code)) return "terminal"
  return "retryable"
}

/** Exponential backoff: base * 2^(attempt-1) → 30s, 60s with default base. */
export function backoffMs(attempt: number, baseMs = readRetryBaseMs()): number {
  const safeAttempt = Math.max(1, attempt)
  return baseMs * 2 ** (safeAttempt - 1)
}

/**
 * Stub record step failure injection: host `fail-{error_code}.test` throws that code.
 * `.test` is reserved and never resolves.
 */
export function parseStubFailureHost(host: string): ErrorCode | null {
  const normalized = host.trim().toLowerCase()
  const match = /^fail-([a-z0-9_]+)\.test$/.exec(normalized)
  if (!match) return null

  const code = match[1]! as ErrorCode
  return (ERROR_CODES as readonly string[]).includes(code) ? code : null
}

export function hostFromLead(domain: string | null, websiteUrl: string | null): string {
  if (domain?.trim()) return domain.trim().toLowerCase()
  if (!websiteUrl?.trim()) return ""
  try {
    return new URL(websiteUrl).hostname.toLowerCase()
  } catch {
    return websiteUrl.trim().toLowerCase()
  }
}
