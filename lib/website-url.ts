import {
  DIRECTORY_HOSTS,
  DIRECTORY_PATH_PATTERNS,
  SOCIAL_HOSTS,
} from "@/lib/import-types"

const TRACKING_PARAMS = [
  /^utm_/i,
  /^fbclid$/i,
  /^gclid$/i,
  /^msclkid$/i,
  /^ref$/i,
  /^mc_cid$/i,
  /^mc_eid$/i,
]

/** Tech.md §5.2 URL normalization. Returns null when unparseable. */
export function normalizeWebsiteUrl(
  raw: string | null | undefined,
): string | null {
  if (raw == null) return null
  let value = raw.trim().replace(/^["']|["']$/g, "")
  if (!value) return null

  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value) && !value.startsWith("//")) {
    value = `https://${value}`
  }

  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }

  url.hostname = url.hostname.toLowerCase()

  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMS.some((pattern) => pattern.test(key))) {
      url.searchParams.delete(key)
    }
  }

  const isBareHost =
    !url.pathname.replace(/\/+$/, "") && !url.search && !url.hash

  if (isBareHost) {
    return `${url.protocol}//${url.host}`
  }

  return url.href
}

function hostMatchesSuffix(host: string, suffix: string): boolean {
  return host === suffix || host.endsWith(`.${suffix}`)
}

/** Social/directory detection — suffix match on host, path patterns for entries with `/`. */
export function isSocialOrDirectory(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }

  const host = parsed.hostname.toLowerCase().replace(/^www\./, "")
  const hostPath = `${host}${parsed.pathname}`.replace(/\/+$/, "")

  if (SOCIAL_HOSTS.some((suffix) => hostMatchesSuffix(host, suffix))) {
    return true
  }

  if (DIRECTORY_HOSTS.some((suffix) => hostMatchesSuffix(host, suffix))) {
    return true
  }

  return DIRECTORY_PATH_PATTERNS.some((pattern) => {
    const normalized = pattern.replace(/\/+$/, "")
    return hostPath === normalized || hostPath.startsWith(`${normalized}/`)
  })
}

/** Returns a disable reason when a skipped lead cannot be re-queued at recording. */
export function skippedRequeueBlockReason(
  websiteUrl: string | null | undefined,
): string | null {
  if (!websiteUrl?.trim()) {
    return "Add a website URL first"
  }
  const normalized = normalizeWebsiteUrl(websiteUrl)
  if (!normalized) {
    return "Website URL is not valid"
  }
  if (isSocialOrDirectory(normalized)) {
    return "URL looks like a social profile or directory listing"
  }
  return null
}
