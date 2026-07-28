import {
  ERROR_CODES,
  ERROR_BUCKETS,
  type ErrorBucket,
  type ErrorCode,
} from "@/lib/pipeline-types"

export const DRAWER_ACTION_IDS = [
  "retry-recording",
  "retry-merge",
  "retry-page",
  "retry-deploy",
  "restart",
  "resume",
  "requeue-recording",
  "edit-fields",
  "assign-intro",
  "remove-lead",
  "terminal",
] as const

export type DrawerActionId = (typeof DRAWER_ACTION_IDS)[number]

export type DrawerAction =
  | { id: Exclude<DrawerActionId, "assign-intro" | "terminal"> }
  | { id: "assign-intro"; href: string }
  | { id: "terminal" }

export type ErrorCopyEntry = {
  sentence: string
  bucket: ErrorBucket
  action: DrawerAction
}

const INTROS_HREF = "/intros"

export const ERROR_COPY: Record<ErrorCode, ErrorCopyEntry> = {
  dns_failure: {
    sentence: "The domain does not resolve — check the website URL.",
    bucket: "bad_website",
    action: { id: "edit-fields" },
  },
  connection_refused: {
    sentence: "The server refused the connection — the site may be down.",
    bucket: "bad_website",
    action: { id: "edit-fields" },
  },
  ssl_error: {
    sentence: "The site's SSL certificate is invalid or expired.",
    bucket: "bad_website",
    action: { id: "edit-fields" },
  },
  http_4xx: {
    sentence: "The page returned a client error (404 or similar).",
    bucket: "bad_website",
    action: { id: "edit-fields" },
  },
  http_5xx: {
    sentence: "The origin server returned an error.",
    bucket: "bad_website",
    action: { id: "edit-fields" },
  },
  parked_domain: {
    sentence: "The domain resolves to a registrar placeholder, not a real site.",
    bucket: "bad_website",
    action: { id: "edit-fields" },
  },
  empty_page: {
    sentence: "The page loaded but had nothing meaningful to scroll.",
    bucket: "bad_website",
    action: { id: "edit-fields" },
  },
  not_a_website: {
    sentence: "This looks like a social profile or directory listing, not a website.",
    bucket: "bad_website",
    action: { id: "requeue-recording" },
  },
  bot_detected: {
    sentence: "The site showed a bot-detection or challenge page.",
    bucket: "blocked",
    action: { id: "retry-recording" },
  },
  captcha: {
    sentence: "A CAPTCHA blocked the recording.",
    bucket: "blocked",
    action: { id: "retry-recording" },
  },
  geo_blocked: {
    sentence: "The site blocked access from this region.",
    bucket: "blocked",
    action: { id: "retry-recording" },
  },
  login_required: {
    sentence: "The site requires a login to view content.",
    bucket: "blocked",
    action: { id: "retry-recording" },
  },
  nav_timeout: {
    sentence: "The page took too long to load.",
    bucket: "blocked",
    action: { id: "retry-recording" },
  },
  browser_crash: {
    sentence: "The browser crashed during capture.",
    bucket: "system",
    action: { id: "retry-recording" },
  },
  ffmpeg_failure: {
    sentence: "Video encoding failed.",
    bucket: "system",
    action: { id: "retry-merge" },
  },
  intro_missing: {
    sentence: "The campaign has no intro video assigned.",
    bucket: "system",
    action: { id: "assign-intro", href: INTROS_HREF },
  },
  missing_asset: {
    sentence: "A required file is missing — re-record to replace it.",
    bucket: "system",
    action: { id: "retry-recording" },
  },
  storage_upload_failed: {
    sentence: "Uploading the video to storage failed.",
    bucket: "system",
    action: { id: "retry-merge" },
  },
  netlify_failure: {
    sentence: "The Netlify deploy failed.",
    bucket: "system",
    action: { id: "retry-deploy" },
  },
  disk_full: {
    sentence: "The worker ran out of disk space.",
    bucket: "system",
    action: { id: "retry-recording" },
  },
  unknown: {
    sentence: "An unexpected error occurred.",
    bucket: "system",
    action: { id: "retry-recording" },
  },
}

export function errorCopyFor(code: ErrorCode): ErrorCopyEntry {
  return ERROR_COPY[code]
}

export function bucketLabel(bucket: ErrorBucket): string {
  switch (bucket) {
    case "bad_website":
      return "Bad Website"
    case "blocked":
      return "Blocked"
    case "system":
      return "System"
    default:
      return bucket
  }
}

/** Re-export for exhaustiveness tests. */
export { ERROR_CODES, ERROR_BUCKETS }
