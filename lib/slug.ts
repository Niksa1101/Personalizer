/** Tech.md §10.1 — lowercase, non-alphanumerics → hyphen, collapse, trim. */
export const SLUG_REGEX = /^[a-z0-9]+(-[a-z0-9]+)*$/

export function slugFromName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
}

export type LeadSlugInput = {
  id: string
  company: string | null
  full_name: string | null
  city: string | null
}

/** Collision-safe storage slug: name fragment + stable lead-id suffix. */
export function leadSlug(lead: LeadSlugInput): string {
  const base = slugFromName(
    [lead.company ?? lead.full_name, lead.city].filter(Boolean).join(" "),
  )
  const suffix = lead.id.replace(/-/g, "").slice(0, 8)
  return base ? `${base}-${suffix}` : suffix
}
