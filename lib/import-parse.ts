import { parse } from "csv-parse/sync"

import {
  DIRECTORY_HOSTS,
  DIRECTORY_PATH_PATTERNS,
  FIELD_ALIASES,
  IMPORT_FIELDS,
  SOCIAL_HOSTS,
  UNMAPPED,
  normalizeHeader,
  type HeaderMapping,
  type ImportField,
  type ParsedImportRow,
  type RejectedRow,
  type SkipReason,
} from "@/lib/import-types"

const UTF8_BOM = "\uFEFF"

const TRACKING_PARAMS = [
  /^utm_/i,
  /^fbclid$/i,
  /^gclid$/i,
  /^msclkid$/i,
  /^ref$/i,
  /^mc_cid$/i,
  /^mc_eid$/i,
]

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export type StripBomResult = {
  text: string
  hadBom: boolean
}

export function stripBom(input: string): StripBomResult {
  if (input.startsWith(UTF8_BOM)) {
    return { text: input.slice(1), hadBom: true }
  }
  return { text: input, hadBom: false }
}

/** Count delimiters in the header line; highest wins, tie → comma (Tech.md §5.1). */
export function detectDelimiter(headerLine: string): string {
  const counts = {
    ",": (headerLine.match(/,/g) ?? []).length,
    ";": (headerLine.match(/;/g) ?? []).length,
    "\t": (headerLine.match(/\t/g) ?? []).length,
  }

  let best = ","
  let bestCount = counts[","]
  for (const [delim, count] of Object.entries(counts)) {
    if (count > bestCount) {
      best = delim
      bestCount = count
    }
  }
  return best
}

export type ParseCsvResult = {
  headers: string[]
  records: string[][]
  lineNumbers: number[]
}

export type CsvRecordWithInfo = {
  record: string[]
  info: { lines: number }
}

/** Parse CSV with 1-based line numbers including the header row. */
export function parseCsv(text: string, delimiter: string): ParseCsvResult {
  const rows = parse(text, {
    bom: true,
    delimiter,
    columns: false,
    relax_column_count: true,
    skip_empty_lines: true,
    relax_quotes: true,
    info: true,
  }) as unknown as CsvRecordWithInfo[]

  if (rows.length === 0) {
    return { headers: [], records: [], lineNumbers: [] }
  }

  const headers = rows[0]!.record.map((cell) => cell.trim())
  const records: string[][] = []
  const lineNumbers: number[] = []

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i]!
    records.push(row.record.map((cell) => cell.trim()))
    lineNumbers.push(recordStartLine(row.record, row.info.lines))
  }

  return { headers, records, lineNumbers }
}

function recordStartLine(record: string[], endLine: number): number {
  const embeddedNewlines = record.reduce((sum, cell) => {
    return sum + (cell.match(/\n/g)?.length ?? 0)
  }, 0)
  return endLine - embeddedNewlines
}

/** Auto-detect header → field mapping from alias table. */
export function detectHeaderMapping(headers: string[]): HeaderMapping {
  const mapping: HeaderMapping = {}
  const claimed = new Set<ImportField>()

  for (const header of headers) {
    const normalized = normalizeHeader(header)
    let matched: ImportField | typeof UNMAPPED = UNMAPPED

    for (const field of IMPORT_FIELDS) {
      if (claimed.has(field)) continue
      const aliases = FIELD_ALIASES[field]
      if (aliases.some((alias) => normalizeHeader(alias) === normalized)) {
        matched = field
        claimed.add(field)
        break
      }
    }

    mapping[header] = matched
  }

  return mapping
}

/** Apply operator mapping; unmapped columns stay in raw only. */
export function mapHeaders(
  headers: string[],
  records: string[][],
  mapping: HeaderMapping,
): Array<Record<string, string>> {
  return records.map((record) => {
    const raw: Record<string, string> = {}
    const row: Record<string, string> = {}

    headers.forEach((header, index) => {
      const value = (record[index] ?? "").trim()
      raw[header] = value
      const field = mapping[header]
      if (field && field !== UNMAPPED && !(field in row)) {
        row[field] = value
      }
    })

    row.raw = JSON.stringify(raw)
    return row
  })
}

export function isValidEmail(value: string): boolean {
  return EMAIL_REGEX.test(value.trim())
}

/** Tech.md §5.2 URL normalization. Returns null when unparseable. */
export function normalizeWebsiteUrl(raw: string | null | undefined): string | null {
  if (raw == null) return null
  let value = raw.trim().replace(/^["']|["']$/g, "")
  if (!value) return null

  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value) && !value.startsWith("//")) {
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

  if (url.pathname.endsWith("/") && !url.search && !url.hash) {
    url.pathname = url.pathname.replace(/\/+$/, "") || "/"
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

  const host = parsed.hostname.toLowerCase()
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

export type ClassifyResult = {
  rows: ParsedImportRow[]
  rejectedRows: RejectedRow[]
}

export function classify(
  headers: string[],
  records: string[][],
  lineNumbers: number[],
  mapping: HeaderMapping,
): ClassifyResult {
  const expectedFields = headers.length
  const rows: ParsedImportRow[] = []
  const rejectedRows: RejectedRow[] = []

  for (let i = 0; i < records.length; i++) {
    const record = records[i]!
    const line = lineNumbers[i]!

    if (record.length !== expectedFields) {
      rejectedRows.push({
        row: line,
        reason: `ragged row: ${record.length} fields, expected ${expectedFields}`,
      })
      continue
    }

    const raw: Record<string, string> = {}
    const mapped: Partial<Record<ImportField, string>> = {}

    headers.forEach((header, index) => {
      const value = (record[index] ?? "").trim()
      raw[header] = value
      const field = mapping[header]
      if (field && field !== UNMAPPED && mapped[field] === undefined) {
        mapped[field] = value
      }
    })

    let email = mapped.email?.trim() || null
    if (email && !isValidEmail(email)) {
      email = null
    }

    const websiteRaw = mapped.website_url?.trim() || null
    const normalizedUrl = normalizeWebsiteUrl(websiteRaw)

    if (!normalizedUrl && websiteRaw && !email) {
      rejectedRows.push({
        row: line,
        reason: "unparseable website URL",
      })
      continue
    }

    let skip: SkipReason | null = null
    if (normalizedUrl && isSocialOrDirectory(normalizedUrl)) {
      skip = "not_a_website"
    }

    const hasDomain = Boolean(normalizedUrl && !skip)
    if (!hasDomain && !email) {
      rejectedRows.push({
        row: line,
        reason: skip
          ? "social-only URL with no email"
          : "no usable website or email",
      })
      continue
    }

    rows.push({
      website_url: skip ? websiteRaw : normalizedUrl,
      email,
      company: mapped.company?.trim() || null,
      first_name: mapped.first_name?.trim() || null,
      last_name: mapped.last_name?.trim() || null,
      full_name: mapped.full_name?.trim() || null,
      phone: mapped.phone?.trim() || null,
      city: mapped.city?.trim() || null,
      state: mapped.state?.trim() || null,
      country: mapped.country?.trim() || null,
      industry: mapped.industry?.trim() || null,
      raw,
      skip,
    })
  }

  return { rows, rejectedRows }
}

/** Full parse pipeline from raw CSV text. */
export function parseImportCsv(
  text: string,
  mapping?: HeaderMapping,
): {
  delimiter: string
  hadBom: boolean
  headers: string[]
  mapping: HeaderMapping
  rows: ParsedImportRow[]
  rejectedRows: RejectedRow[]
  rowCount: number
} {
  const { text: stripped, hadBom } = stripBom(text)
  const firstLine = stripped.split(/\r?\n/, 1)[0] ?? ""
  const delimiter = detectDelimiter(firstLine)
  const { headers, records, lineNumbers } = parseCsv(stripped, delimiter)
  const resolvedMapping = mapping ?? detectHeaderMapping(headers)
  const { rows, rejectedRows } = classify(
    headers,
    records,
    lineNumbers,
    resolvedMapping,
  )

  return {
    delimiter,
    hadBom,
    headers,
    mapping: resolvedMapping,
    rows,
    rejectedRows,
    rowCount: records.length,
  }
}

export function mappingHasWebsiteUrl(mapping: HeaderMapping): boolean {
  return Object.values(mapping).includes("website_url")
}
