/**
 * Site-ownership classification for the deploy guard (docs/Tech.md §17 risk 9).
 *
 * Pure and dependency-free on purpose: `sync.ts` imports this, so importing
 * anything back out of `sync.ts` here would form a cycle.
 *
 * Three-way split, not two. The app's own debris — a page mid-rebuild, a slug that
 * changed, a half-landed deploy — is app-shaped but has no row. Calling that "foreign"
 * makes the guard cry wolf at itself, and a guard that cries wolf gets disabled. So it
 * is reported, not refused.
 */

import type { NetlifyClient } from "./netlify"
import { getManifestCache } from "@/lib/queue"
import { listAdoptedSitePaths, listOwnedSitePaths, writeDeployerLog } from "../db"

/** Always ours: emitted by buildManifest(), never by anything else. */
export const STRUCTURAL_PATHS: readonly string[] = ["/robots.txt", "/404.html"]

/**
 * `/<campaign-slug>/<lead-slug>/index.html` — the only shape the app publishes for a
 * lead. Derived from landingPath() (lib/landing-page.ts:104) + manifestFilePath()
 * (worker/deploy/sync.ts:42). Keep these three in sync.
 */
const APP_PAGE_PATH = /^\/[^/]+\/[^/]+\/index\.html$/

export type PathClass = "structural" | "owned" | "orphaned" | "foreign"

export function classifySitePath(
  path: string,
  ownedPaths: ReadonlySet<string>,
  adoptedPaths: ReadonlySet<string>,
): PathClass {
  if (STRUCTURAL_PATHS.includes(path)) return "structural"
  if (ownedPaths.has(path)) return "owned"
  if (adoptedPaths.has(path)) return "owned"
  if (APP_PAGE_PATH.test(path)) return "orphaned"
  return "foreign"
}

export type OwnershipReport = {
  foreign: string[]
  orphaned: string[]
  ownedCount: number
  totalCount: number
}

export function classifySiteFiles(input: {
  sitePaths: readonly string[]
  ownedPaths: ReadonlySet<string>
  adoptedPaths: ReadonlySet<string>
}): OwnershipReport {
  const foreign: string[] = []
  const orphaned: string[] = []
  let ownedCount = 0

  for (const path of input.sitePaths) {
    switch (classifySitePath(path, input.ownedPaths, input.adoptedPaths)) {
      case "foreign":
        foreign.push(path)
        break
      case "orphaned":
        orphaned.push(path)
        break
      default:
        ownedCount += 1
    }
  }

  return {
    foreign: foreign.sort(),
    orphaned: orphaned.sort(),
    ownedCount,
    totalCount: input.sitePaths.length,
  }
}

/** Console output stays readable; the full list goes to the deployer log. */
export const FOREIGN_SAMPLE_LIMIT = 20

export class SiteOwnershipError extends Error {
  readonly siteId: string
  readonly foreignCount: number
  readonly sample: string[]

  constructor(siteId: string, foreign: readonly string[]) {
    const sample = foreign.slice(0, FOREIGN_SAMPLE_LIMIT)
    const overflow = foreign.length - sample.length
    super(
      `Refusing to deploy: site ${siteId} holds ${foreign.length} file(s) this app does not own. ` +
        `A deploy is a full-manifest replacement and would delete them.\n` +
        sample.map((p) => `  ${p}`).join("\n") +
        (overflow > 0 ? `\n  …and ${overflow} more (full list in the deployer log)` : "") +
        `\nIf this app should own them, adopt them: npm run adopt:site`,
    )
    this.name = "SiteOwnershipError"
    this.siteId = siteId
    this.foreignCount = foreign.length
    this.sample = sample
  }
}

/**
 * Cold-cache only. A warm manifest cache means we have deployed this site before and
 * the mass-removal floor already covers it; re-listing every deploy would cost an API
 * call per deploy forever for nothing.
 *
 * `cachedPaths` mirrors resolvePreviousManifestPaths()'s hermetic escape hatch: pass it
 * explicitly (including `null`) to drive this from a test without Redis.
 */
export async function assertSiteOwnership(input: {
  siteId: string
  client: Pick<NetlifyClient, "listSiteFiles">
  cachedPaths?: readonly string[] | null
}): Promise<void> {
  const cached =
    input.cachedPaths === undefined
      ? (await getManifestCache())?.paths
      : input.cachedPaths
  if (cached && cached.length > 0) return // warm — not our case

  const sitePaths = await input.client.listSiteFiles()
  if (!sitePaths) {
    // Same posture as the removal guard on an unusable /files response: proceed
    // rather than guess. Refusing here would block every deploy on a Netlify blip.
    await writeDeployerLog({
      level: "warn",
      message: "Ownership guard skipped — site file listing unavailable",
      meta: { site_id: input.siteId },
    })
    return
  }
  if (sitePaths.length === 0) return // empty site — nothing to destroy

  const [owned, adopted] = await Promise.all([
    listOwnedSitePaths(),
    listAdoptedSitePaths(input.siteId),
  ])

  const report = classifySiteFiles({
    sitePaths,
    ownedPaths: new Set(owned),
    adoptedPaths: new Set(adopted),
  })

  if (report.orphaned.length > 0) {
    await writeDeployerLog({
      level: "warn",
      message: `Ownership guard: ${report.orphaned.length} app-shaped path(s) with no row`,
      meta: { site_id: input.siteId, orphaned: report.orphaned },
    })
  }

  if (report.foreign.length === 0) {
    await writeDeployerLog({
      level: "info",
      message: "Ownership guard passed on a cold cache",
      meta: {
        site_id: input.siteId,
        total: report.totalCount,
        owned: report.ownedCount,
        orphaned: report.orphaned.length,
      },
    })
    return
  }

  // Full list to the log; the throw carries a readable sample. Without this the
  // operator reads Netlify's file list by hand.
  await writeDeployerLog({
    level: "error",
    message: "Deploy refused — site holds files this app does not own",
    meta: {
      site_id: input.siteId,
      foreign_count: report.foreign.length,
      foreign: report.foreign,
      orphaned: report.orphaned,
      total: report.totalCount,
    },
  })

  throw new SiteOwnershipError(input.siteId, report.foreign)
}
