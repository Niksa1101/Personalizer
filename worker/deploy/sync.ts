import { buildReconcileRows } from "@/lib/deploy-reconcile"
import { assertEnv } from "@/lib/env"
import {
  clearDeployDirty,
  getManifestCache,
  isDeployDirty,
  setDeployDirty,
  setManifestCache,
  type ManifestCacheEntry,
} from "@/lib/queue"
import { resolveMany } from "@/lib/settings"

import {
  clearPendingSiteSyncUpTo,
  deleteRetainedByPath,
  listManifestPages,
  listRetainedPages,
  markLandingPagesUploading,
  reconcileManifestDeployRows,
  repairLandingPageContentSha1,
  writeDeployerLog,
  type ManifestPageRow,
} from "../db"
import { acquireDeployLock } from "./lock"
import {
  buildManifest,
  detectMassRemoval,
  diffPaths,
  manifestHash,
  ManifestMassRemovalError,
  type ManifestBuildResult,
} from "./manifest"
import { assertSiteOwnership } from "./ownership"
import { createNetlifyClient, type NetlifyClient } from "./netlify"

const MAX_SYNC_PASSES = 3
const DEPLOY_TITLE_MAX = 120

export type SiteSyncContext = {
  signal?: AbortSignal
}

export function manifestFilePath(pagePath: string): string {
  return `${pagePath}/index.html`
}

function buildSiteSyncDeployTitle(pageCount: number): string {
  const stamp = new Date().toISOString()
  const title = `pz site-sync ${pageCount}p ${stamp}`
  return title.length <= DEPLOY_TITLE_MAX
    ? title
    : title.slice(0, DEPLOY_TITLE_MAX)
}

export function totalManifestBytes(manifest: ManifestBuildResult): number {
  return Object.values(manifest.bytes).reduce((sum, buf) => sum + buf.length, 0)
}

/**
 * Netlify's digest deploy only wants the digests it reported as `required`
 * (Tech.md §10.3). Uploading the whole manifest defeats the protocol: 100 leads
 * with one change must cost one PUT, not 102.
 *
 * D34 — the unit is the *path*, not the digest. Two leads whose HTML happens to
 * be byte-identical share one digest but are two paths, and both must be PUT.
 */
export function planUploads(
  files: Record<string, string>,
  required: readonly string[],
): string[] {
  const requiredDigests = new Set(required)
  return Object.keys(files)
    .filter((path) => requiredDigests.has(files[path]!))
    .sort()
}

export async function assembleManifestFromDb(): Promise<{
  manifest: ManifestBuildResult
  pages: ManifestPageRow[]
}> {
  const [pages, retained] = await Promise.all([
    listManifestPages(),
    listRetainedPages(),
  ])

  const manifest = buildManifest({
    pages: pages.map((row) => ({
      path: row.path,
      html: row.html,
      content_sha1: row.content_sha1,
      source: "landing_pages",
      ref: row.id,
    })),
    retained: retained.map((row) => ({
      path: row.path,
      html: row.html,
      content_sha1: row.content_sha1,
      source: "retained_pages",
      ref: row.id,
    })),
  })

  for (const repair of manifest.stats.repairs) {
    if (repair.source !== "landing_pages") continue
    const page = pages.find((row) => row.path === repair.path)
    if (!page) continue
    await repairLandingPageContentSha1({
      pageId: page.id,
      contentSha1: repair.computedSha1,
    })
    await writeDeployerLog({
      level: "warn",
      message: `Repaired landing page SHA-1 mismatch at ${repair.path}`,
      meta: {
        path: repair.path,
        stored_sha1: repair.storedSha1,
        computed_sha1: repair.computedSha1,
      },
    })
  }

  for (const warning of manifest.stats.warnings) {
    await writeDeployerLog({
      level: "warn",
      message: warning,
    })
  }

  return { manifest, pages }
}

export type PublishManifestResult = {
  deployId: string
  siteUrl: string
  requiredCount: number
  uploadedCount: number
}

export async function publishManifest(input: {
  manifest: ManifestBuildResult
  pages: ManifestPageRow[]
  title: string
  signal?: AbortSignal
  /** Injected for tests and verify:deploy; defaults to the real client. */
  client?: NetlifyClient
  /** Skips the settings lookup when the caller already has a budget. */
  budgetMs?: number
  /** Hermetic escape hatch for tests; omit in production. */
  ownershipCachedPaths?: readonly string[] | null
}): Promise<PublishManifestResult> {
  const budgetMs =
    input.budgetMs ??
    (await resolveMany(["deploy.timeout_ms"]))["deploy.timeout_ms"]
  const client = input.client ?? createNetlifyClient({ signal: input.signal })

  await assertSiteOwnership({
    siteId: assertEnv().NETLIFY_SITE_ID,
    client,
    cachedPaths: input.ownershipCachedPaths,
  })

  const deploy = await client.createDeploy(input.manifest.files, input.title)

  const requiredDigests = new Set(deploy.required)
  const uploadingPageIds = input.pages
    .filter(
      (page) =>
        (page.deploy_status === "pending" || page.deploy_status === "failed") &&
        requiredDigests.has(input.manifest.files[manifestFilePath(page.path)]!),
    )
    .map((page) => page.id)
  const uploading = await markLandingPagesUploading(uploadingPageIds)
  if (uploading.updated !== uploading.expected) {
    await writeDeployerLog({
      level: "warn",
      message: "Landing page status drifted between manifest read and upload",
      meta: { expected: uploading.expected, updated: uploading.updated },
    })
  }

  const satisfiedDigests = new Set<string>()
  const uploadPaths = planUploads(input.manifest.files, deploy.required)
  for (const path of uploadPaths) {
    await client.uploadFile(
      deploy.id,
      path,
      input.manifest.bytes[path]!,
      satisfiedDigests,
    )
  }

  await client.waitForReady(deploy.id, budgetMs)
  const siteUrl = await client.getSiteUrl()

  return {
    deployId: deploy.id,
    siteUrl,
    requiredCount: deploy.required.length,
    uploadedCount: uploadPaths.length,
  }
}

export async function reconcileManifestDeploy(input: {
  manifest: ManifestBuildResult
  pages: ManifestPageRow[]
  deployId: string
  siteUrl: string
  previousCache: ManifestCacheEntry | null
  /** Absent when the deploy was skipped on an unchanged manifest hash. */
  requiredCount?: number
  uploadedCount?: number
}): Promise<void> {
  const deployedAt = new Date().toISOString()
  const manifestPaths = Object.keys(input.manifest.files).sort()

  await reconcileManifestDeployRows({
    rows: buildReconcileRows(input.pages, input.siteUrl),
    netlifyDeployId: input.deployId,
    deployedAt,
  })

  for (const path of input.manifest.stats.deleteRetainedPaths) {
    await deleteRetainedByPath(path)
  }



  const diff = diffPaths(input.previousCache?.paths, manifestPaths)
  const removedPreview = diff.removed.slice(0, 20)
  const removedOverflow =
    diff.removed.length > removedPreview.length
      ? diff.removed.length - removedPreview.length
      : 0

  const cacheEntry: ManifestCacheEntry = {
    sha: manifestHash(input.manifest.files),
    deploy_id: input.deployId,
    at: deployedAt,
    paths: manifestPaths,
  }
  await setManifestCache(cacheEntry)

  await writeDeployerLog({
    level: "info",
    message: "Site sync deploy completed",
    meta: {
      deploy_id: input.deployId,
      manifest_paths: manifestPaths.length,
      page_count: input.manifest.stats.pageCount,
      retained_count: input.manifest.stats.retainedCount,
      bytes: totalManifestBytes(input.manifest),
      manifest_file_count: Object.keys(input.manifest.files).length,
      required_count: input.requiredCount ?? 0,
      uploaded_count: input.uploadedCount ?? 0,
      added_count: diff.added.length,
      removed_count: diff.removed.length,
      removed_paths: removedPreview,
      removed_overflow: removedOverflow,
    },
  })
}

/** Returns the instant the manifest was read — the watermark this pass satisfies. */
async function runSiteSyncPass(ctx: SiteSyncContext): Promise<string> {
  await clearDeployDirty()

  const assembledAt = new Date().toISOString()
  const previousCache = await getManifestCache()
  const { manifest, pages } = await assembleManifestFromDb()

  const massRemoval = detectMassRemoval({
    previousPaths: previousCache?.paths,
    currentPaths: Object.keys(manifest.files).sort(),
  })
  if (massRemoval.blocked) {
    await writeDeployerLog({
      level: "error",
      message: "Site sync refused — manifest would unpublish most of the site",
      meta: {
        removed_count: massRemoval.removedCount,
        previous_count: massRemoval.previousCount,
        page_count: manifest.stats.pageCount,
      },
    })
    throw new ManifestMassRemovalError(
      massRemoval.removedCount,
      massRemoval.previousCount,
    )
  }

  const published = await publishManifest({
    manifest,
    pages,
    title: buildSiteSyncDeployTitle(manifest.stats.pageCount),
    signal: ctx.signal,
  })

  await reconcileManifestDeploy({
    manifest,
    pages,
    deployId: published.deployId,
    siteUrl: published.siteUrl,
    previousCache,
    requiredCount: published.requiredCount,
    uploadedCount: published.uploadedCount,
  })

  return assembledAt
}

/**
 * Markers are satisfied by any deploy that read the DB after they were written.
 * Clearing them is best-effort: a stale marker only costs one redundant sync,
 * whereas failing the whole job here would strand the deploy that just landed.
 */
async function drainPendingSiteSync(watermark: string): Promise<void> {
  try {
    const cleared = await clearPendingSiteSyncUpTo(watermark)
    if (cleared > 0) {
      await writeDeployerLog({
        level: "info",
        message: `Cleared ${cleared} pending site-sync marker(s)`,
        meta: { watermark, cleared },
      })
    }
  } catch (error) {
    console.error("[site-sync] failed to clear pending markers:", error)
  }
}

export async function runSiteSync(ctx: SiteSyncContext = {}): Promise<void> {
  const siteId = assertEnv().NETLIFY_SITE_ID
  const lock = await acquireDeployLock({
    siteId,
    signal: ctx.signal,
  })
  const stopRenewal = lock.startRenewal()

  try {
    for (let pass = 1; pass <= MAX_SYNC_PASSES; pass++) {
      const assembledAt = await runSiteSyncPass(ctx)
      if (!(await isDeployDirty(siteId))) {
        await drainPendingSiteSync(assembledAt)
        return
      }
      if (pass === MAX_SYNC_PASSES) {
        console.warn(
          `[site-sync] dirty after ${MAX_SYNC_PASSES} passes — completed listener will re-enqueue`,
        )
        await drainPendingSiteSync(assembledAt)
      }
    }
  } catch (error) {
    await setDeployDirty(siteId)
    throw error
  } finally {
    stopRenewal()
    await lock.release()
  }
}
