/**
 * Excel strips quotes before parsing, so D29's unconditional quoting does NOT
 * mitigate formula injection. These are two independent controls (D30).
 */
const INJECTION_PREFIX = /^[=+\-@\t\r]/

export function escapeCsvCell(value: string | null | undefined): string {
  if (value == null || value === "") return '""'
  const guarded = INJECTION_PREFIX.test(value) ? `'${value}` : value
  return `"${guarded.replace(/"/g, '""')}"`
}

/** CRLF-terminated, every record including the last. No BOM — the route adds it (D29/W7). */
export function toCsv(
  headers: readonly string[],
  rows: readonly (readonly (string | null)[])[],
): string {
  const lines = [
    headers.map((h) => escapeCsvCell(h)).join(","),
    ...rows.map((row) => row.map((cell) => escapeCsvCell(cell)).join(",")),
  ]
  return `${lines.join("\r\n")}\r\n`
}
