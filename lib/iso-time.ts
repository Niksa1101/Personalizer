const ISO_TIMESTAMP_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/

/** Shape check first — `Date.parse("2026")` succeeds but is not a log cursor. */
export function isIsoTimestamp(value: string): boolean {
  if (!ISO_TIMESTAMP_RE.test(value)) return false
  return Number.isFinite(Date.parse(value))
}

export function parseIsoDateOrNull(value: string | undefined): Date | null {
  if (!value) return null
  if (!isIsoTimestamp(value)) return null
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime()) ? parsed : null
}
