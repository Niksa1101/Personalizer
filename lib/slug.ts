/** Tech.md §10.1 — lowercase, non-alphanumerics → hyphen, collapse, trim. */
export const SLUG_REGEX = /^[a-z0-9]+(-[a-z0-9]+)*$/

export function slugFromName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
}
