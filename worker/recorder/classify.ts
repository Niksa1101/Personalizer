import { isSocialOrDirectory } from "@/lib/import-parse"
import type { ErrorCode } from "@/lib/pipeline-types"

export type PageProbe = {
  innerTextLength: number
  scrollHeight: number
  viewportHeight: number
  finalUrl: string
  bodyHtml: string
}

export type ClassifyContext = {
  err?: unknown
  httpStatus?: number | null
  page?: PageProbe | null
  url: string
}

const PARKED_MARKERS = [
  "domain is for sale",
  "buy this domain",
  "this domain may be for sale",
  "domain parked",
  "parked free",
  "godaddy",
  "hugedomains",
  "sedo parking",
  "namecheap",
  "coming soon",
  "under construction",
  "website coming soon",
]

const BOT_MARKERS = [
  "checking your browser",
  "just a moment",
  "attention required",
  "cloudflare",
  "perimeterx",
  "datadome",
  "access denied",
  "please verify you are a human",
  "cf-browser-verification",
]

const GEO_MARKERS = [
  "not available in your country",
  "not available in your region",
  "geo-blocked",
  "access from your location",
]

const LOGIN_PATH_MARKERS = [
  "/login",
  "/signin",
  "/sign-in",
  "/log-in",
  "/auth",
  "/account/login",
  "/users/sign_in",
]

const LOGIN_HOST_MARKERS = ["accounts.google.com", "login.microsoftonline.com"]

const LOGIN_QUERY_KEYS = ["login", "signin", "auth", "oauth"]

function readErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

function readErrorName(err: unknown): string {
  if (err instanceof Error) return err.name
  return ""
}

function includesAny(haystack: string, needles: readonly string[]): boolean {
  const lower = haystack.toLowerCase()
  return needles.some((needle) => lower.includes(needle))
}

function isLoginRoute(finalUrl: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(finalUrl)
  } catch {
    return false
  }

  const host = parsed.hostname.toLowerCase()
  if (LOGIN_HOST_MARKERS.some((marker) => host.includes(marker))) {
    return true
  }

  const path = parsed.pathname.toLowerCase()
  if (LOGIN_PATH_MARKERS.some((marker) => path.includes(marker))) {
    return true
  }

  for (const key of LOGIN_QUERY_KEYS) {
    if (parsed.searchParams.has(key)) return true
  }

  return false
}

function isEmptyPage(page: PageProbe): boolean {
  const heightNearViewport =
    page.scrollHeight <= page.viewportHeight * 1.15
  return page.innerTextLength < 200 && heightNearViewport
}

function isParkedDomain(page: PageProbe): boolean {
  return includesAny(page.bodyHtml, PARKED_MARKERS)
}

function isBotDetected(page: PageProbe): boolean {
  return includesAny(page.bodyHtml, BOT_MARKERS)
}

function isCaptcha(page: PageProbe): boolean {
  const lower = page.bodyHtml.toLowerCase()
  return (
    lower.includes("recaptcha") ||
    lower.includes("hcaptcha") ||
    lower.includes("g-recaptcha")
  )
}

function isGeoBlocked(status: number | null | undefined, page: PageProbe): boolean {
  if (status !== 403) return false
  return includesAny(page.bodyHtml, GEO_MARKERS)
}

function classifyHttpStatus(status: number): ErrorCode | null {
  if (status === 404 || status === 410) return "http_4xx"
  if (status >= 400 && status < 500) return "http_4xx"
  if (status >= 500) return "http_5xx"
  return null
}

function classifyNetworkError(message: string, name: string): ErrorCode | null {
  const lower = message.toLowerCase()
  if (
    lower.includes("enotfound") ||
    lower.includes("eai_again") ||
    lower.includes("err_name_not_resolved") ||
    lower.includes("nxdomain")
  ) {
    return "dns_failure"
  }
  if (
    lower.includes("econnrefused") ||
    lower.includes("err_connection_refused")
  ) {
    return "connection_refused"
  }
  if (
    lower.includes("err_cert") ||
    lower.includes("ssl") ||
    lower.includes("certificate")
  ) {
    return "ssl_error"
  }
  if (
    lower.includes("timeout") ||
    lower.includes("timed out") ||
    name === "TimeoutError"
  ) {
    return "nav_timeout"
  }
  if (
    lower.includes("target crashed") ||
    lower.includes("browser has been closed") ||
    lower.includes("browser crashed")
  ) {
    return "browser_crash"
  }
  return null
}

/** Map capture symptoms to database error_code values (Tech.md §8.6). */
export function classifyCaptureError(ctx: ClassifyContext): ErrorCode {
  if (ctx.err) {
    const message = readErrorMessage(ctx.err)
    const name = readErrorName(ctx.err)
    const fromNetwork = classifyNetworkError(message, name)
    if (fromNetwork) return fromNetwork
  }

  if (ctx.httpStatus != null) {
    if (ctx.page && isGeoBlocked(ctx.httpStatus, ctx.page)) {
      return "geo_blocked"
    }
    const fromStatus = classifyHttpStatus(ctx.httpStatus)
    if (fromStatus) return fromStatus
  }

  if (ctx.page) {
    if (isSocialOrDirectory(ctx.url) || isSocialOrDirectory(ctx.page.finalUrl)) {
      return "not_a_website"
    }
    if (isParkedDomain(ctx.page)) return "parked_domain"
    if (isEmptyPage(ctx.page)) return "empty_page"
    if (isCaptcha(ctx.page)) return "captcha"
    if (isBotDetected(ctx.page)) return "bot_detected"
    if (isLoginRoute(ctx.page.finalUrl)) return "login_required"
  }

  return "unknown"
}
