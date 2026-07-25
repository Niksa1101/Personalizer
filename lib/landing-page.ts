import {
  substituteTemplate,
  type TemplatePlaceholder,
  type TemplateValues,
} from "@/lib/landing-template"

const HTML_ESCAPE_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
}

const URL_PLACEHOLDERS = new Set<TemplatePlaceholder>([
  "video_url",
  "poster_url",
  "cta_url",
  "website_url",
])

const HTTP_URL_PATTERN = /^https?:\/\//i
const INLINE_IMAGE_PATTERN = /^data:image\/(?:jpeg|png|webp);base64,/i

/** Escape text safe for element content and quoted attributes (D18). */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ESCAPE_MAP[char] ?? char)
}

/** Allowlisted URL schemes for substituted placeholders (D20). */
export function safeUrl(value: string, options?: { allowContactSchemes?: boolean }): string {
  const trimmed = value.trim()
  if (!trimmed) return ""

  if (HTTP_URL_PATTERN.test(trimmed) || INLINE_IMAGE_PATTERN.test(trimmed)) {
    return trimmed
  }

  if (options?.allowContactSchemes) {
    if (/^mailto:/i.test(trimmed) || /^tel:/i.test(trimmed)) {
      return trimmed
    }
  }

  return ""
}

export type CtaType = "calendar" | "website" | "email" | "phone" | "custom"

/** Derive the CTA href from campaign cta_type (D21). */
export function deriveCtaHref(
  ctaType: CtaType | string | null | undefined,
  rawUrl: string,
): string {
  const trimmed = rawUrl.trim()
  if (!trimmed) return ""

  switch (ctaType) {
    case "email":
      if (/^mailto:/i.test(trimmed)) return trimmed
      return `mailto:${trimmed}`
    case "phone":
      if (/^tel:/i.test(trimmed)) return trimmed
      return `tel:${trimmed}`
    default:
      return trimmed
  }
}

/** Remove anchor tags whose href resolved empty (D23). */
export function dropEmptyAnchors(html: string): string {
  return html.replace(
    /<a\b[^>]*\bhref\s*=\s*(?:""|''|"[\s]*"|'[\s]*')[^>]*>[\s\S]*?<\/a>/gi,
    "",
  )
}

/** Strip empty poster="" and downgrade preload when poster is absent (D14). */
export function applyPosterFallback(html: string): string {
  let result = html.replace(/\s+poster\s*=\s*""/gi, "")
  result = result.replace(/\s+poster\s*=\s*''/gi, "")

  if (!/\sposter\s*=\s*["'][^"']+["']/i.test(result)) {
    result = result.replace(/\bpreload\s*=\s*["']none["']/gi, 'preload="metadata"')
  }

  return result
}

/** Normalize line endings to LF before hashing or storage (D32). */
export function normalizeLf(html: string): string {
  return html.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
}

/** Site-relative landing path: /{campaign-slug}/{lead-slug} (D38). */
export function landingPath(campaignSlug: string, leadSlug: string): string {
  return `/${campaignSlug}/${leadSlug}`
}

export type RenderLandingOptions = {
  cta_type?: CtaType | string | null
}

function prepareValues(
  values: TemplateValues,
  options?: RenderLandingOptions,
): TemplateValues {
  const prepared: TemplateValues = {}

  for (const [key, raw] of Object.entries(values) as [TemplatePlaceholder, string | undefined][]) {
    if (raw === undefined) continue

    if (key === "cta_url") {
      const derived = deriveCtaHref(options?.cta_type, raw)
      prepared.cta_url = safeUrl(derived, { allowContactSchemes: true })
      continue
    }

    if (URL_PLACEHOLDERS.has(key)) {
      prepared[key] = safeUrl(raw)
      continue
    }

    prepared[key] = escapeHtml(raw)
  }

  return prepared
}

/** Full public-page render: substitute → escape → CTA derive → cleanup → LF (D2, D31). */
export function renderLandingHtml(
  template: string,
  values: TemplateValues,
  options?: RenderLandingOptions,
): string {
  const prepared = prepareValues(values, options)
  let html = substituteTemplate(template, prepared)
  html = dropEmptyAnchors(html)
  html = applyPosterFallback(html)
  return normalizeLf(html)
}
