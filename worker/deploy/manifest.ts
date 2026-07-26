import { createHash } from "node:crypto"

import { notFoundHtml } from "@/lib/not-found-page"
import { robotsTxtBody } from "@/lib/robots-txt"

const ROBOTS_PATH = "/robots.txt"
const NOT_FOUND_PATH = "/404.html"

export type ManifestSourceRow = {
  path: string
  html: string
  content_sha1: string
  source: string
  ref?: string
}

export type ManifestBuildInput = {
  pages: ManifestSourceRow[]
  retained: ManifestSourceRow[]
}

export type ManifestDigestRepair = {
  path: string
  manifestPath: string
  storedSha1: string
  computedSha1: string
  source: string
}

export type ManifestCollision = {
  path: string
  retainedSource: string
  liveSource: string
}

export type ManifestBuildStats = {
  pageCount: number
  retainedCount: number
  siteFileCount: number
  collisions: ManifestCollision[]
  deleteRetainedPaths: string[]
  repairs: ManifestDigestRepair[]
  warnings: string[]
}

export type ManifestBuildResult = {
  files: Record<string, string>
  bytes: Record<string, Buffer>
  stats: ManifestBuildStats
}

export class ManifestDuplicatePathError extends Error {
  readonly manifestPath: string
  readonly sourceA: string
  readonly sourceB: string

  constructor(manifestPath: string, sourceA: string, sourceB: string) {
    super(
      `Duplicate manifest path ${manifestPath}: ${sourceA} and ${sourceB}`,
    )
    this.name = "ManifestDuplicatePathError"
    this.manifestPath = manifestPath
    this.sourceA = sourceA
    this.sourceB = sourceB
  }
}

function formatSource(row: ManifestSourceRow): string {
  return row.ref ? `${row.source} (${row.ref})` : row.source
}

function manifestFilePath(pagePath: string): string {
  return `${pagePath}/index.html`
}

export function sha1Hex(content: string): string {
  return createHash("sha1").update(content, "utf8").digest("hex")
}

export function buildManifest(input: ManifestBuildInput): ManifestBuildResult {
  const collisions: ManifestCollision[] = []
  const deleteRetainedPaths: string[] = []
  const warnings: string[] = []

  const retainedRows: ManifestSourceRow[] = []
  for (const row of input.retained) {
    const liveRow = input.pages.find((page) => page.path === row.path)
    if (liveRow) {
      collisions.push({
        path: row.path,
        retainedSource: formatSource(row),
        liveSource: formatSource(liveRow),
      })
      deleteRetainedPaths.push(row.path)
      warnings.push(
        `Retained page ${row.path} collides with live landing page; live wins — retained row scheduled for deletion`,
      )
      continue
    }
    retainedRows.push(row)
  }

  const entries = [
    ...input.pages.map((row) => ({
      row,
      manifestPath: manifestFilePath(row.path),
    })),
    ...retainedRows.map((row) => ({
      row,
      manifestPath: manifestFilePath(row.path),
    })),
  ]

  const byManifestPath = new Map<string, ManifestSourceRow[]>()
  for (const entry of entries) {
    const group = byManifestPath.get(entry.manifestPath) ?? []
    group.push(entry.row)
    byManifestPath.set(entry.manifestPath, group)
  }

  for (const [manifestPath, rows] of byManifestPath) {
    if (rows.length <= 1) continue
    throw new ManifestDuplicatePathError(
      manifestPath,
      formatSource(rows[0]!),
      formatSource(rows[1]!),
    )
  }

  const files: Record<string, string> = {}
  const bytes: Record<string, Buffer> = {}
  const repairs: ManifestDigestRepair[] = []

  for (const entry of entries) {
    const computedSha1 = sha1Hex(entry.row.html)
    let digest = entry.row.content_sha1

    if (computedSha1 !== entry.row.content_sha1) {
      repairs.push({
        path: entry.row.path,
        manifestPath: entry.manifestPath,
        storedSha1: entry.row.content_sha1,
        computedSha1,
        source: entry.row.source,
      })
      digest = computedSha1
    }

    files[entry.manifestPath] = digest
    bytes[entry.manifestPath] = Buffer.from(entry.row.html, "utf8")
  }

  const robotsBody = robotsTxtBody()
  const notFoundBody = notFoundHtml()
  files[ROBOTS_PATH] = sha1Hex(robotsBody)
  bytes[ROBOTS_PATH] = Buffer.from(robotsBody, "utf8")
  files[NOT_FOUND_PATH] = sha1Hex(notFoundBody)
  bytes[NOT_FOUND_PATH] = Buffer.from(notFoundBody, "utf8")

  return {
    files,
    bytes,
    stats: {
      pageCount: input.pages.length,
      retainedCount: retainedRows.length,
      siteFileCount: 2,
      collisions,
      deleteRetainedPaths,
      repairs,
      warnings,
    },
  }
}

export function manifestHash(files: Record<string, string>): string {
  const lines = Object.keys(files)
    .sort()
    .map((path) => `${path}\t${files[path]}`)
  return sha1Hex(lines.join("\n"))
}

/**
 * A deploy is a full-state push: whatever the manifest omits gets unpublished.
 * A partial read (truncated query, half-migrated data) therefore looks exactly
 * like a mass delete. Removing most of the site in one pass is far more likely
 * to be a bug than an intent, so it is refused rather than published.
 *
 * Threshold is a *fraction of the previous set*; small sites are exempt because
 * deleting 2 of 3 pages is ordinary.
 */
export const MASS_REMOVAL_MIN_PREVIOUS = 20
export const MASS_REMOVAL_FRACTION = 0.5

export function detectMassRemoval(input: {
  previousPaths: readonly string[] | null | undefined
  currentPaths: readonly string[]
}): { blocked: boolean; removedCount: number; previousCount: number } {
  const previousCount = input.previousPaths?.length ?? 0
  const { removed } = diffPaths(input.previousPaths, input.currentPaths)

  const blocked =
    previousCount >= MASS_REMOVAL_MIN_PREVIOUS &&
    removed.length > previousCount * MASS_REMOVAL_FRACTION

  return { blocked, removedCount: removed.length, previousCount }
}

export class ManifestMassRemovalError extends Error {
  readonly removedCount: number
  readonly previousCount: number

  constructor(removedCount: number, previousCount: number) {
    super(
      `Refusing to deploy: manifest drops ${removedCount} of ${previousCount} published paths. ` +
        `Verify the database before retrying (Tech.md §10.3).`,
    )
    this.name = "ManifestMassRemovalError"
    this.removedCount = removedCount
    this.previousCount = previousCount
  }
}

export function diffPaths(
  previous: readonly string[] | null | undefined,
  current: readonly string[],
): { added: string[]; removed: string[] } {
  const previousSet = new Set(previous ?? [])
  const currentSet = new Set(current)

  const added = [...currentSet].filter((path) => !previousSet.has(path)).sort()
  const removed = [...previousSet].filter((path) => !currentSet.has(path)).sort()

  return { added, removed }
}
