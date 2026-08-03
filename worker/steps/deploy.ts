import { assertEnv } from "@/lib/env"
import { landingPath } from "@/lib/landing-page"
import { enqueueSiteSync, getManifestCache, setDeployDirty } from "@/lib/queue"
import { readStubStepMs } from "@/lib/pipeline-env"
import {
  abortableDelay,
  PipelineStepError,
  ShutdownError,
} from "@/lib/pipeline-types"
import { resolveMany } from "@/lib/settings"

import {
  cleanupLocalWebMp4,
  insertPipelineEvent,
  loadDeployLandingPage,
  loadLeadRef,
  markLandingPageFailed,
  markLeadDeployedDryRun,
  writeDeployerLog,
} from "../db"
import { acquireDeployLock } from "../deploy/lock"
import {
  diffPaths,
  manifestHash,
  ManifestDuplicatePathError,
} from "../deploy/manifest"
import {
  NetlifyError,
  createNetlifyClient,
  type NetlifyClient,
} from "../deploy/netlify"
import { SiteOwnershipError } from "../deploy/ownership"
import {
  assembleManifestFromDb,
  publishManifest,
  reconcileManifestDeploy,
  totalManifestBytes,
} from "../deploy/sync"
import { runPageGenerate } from "../page/generate"
import type { Step, StepContext } from "./shared"

const MAX_DEPLOY_PASSES = 3
const REMOVAL_POLL_MS = 2_000
const DEPLOY_TITLE_MAX = 120

type StaleReason =
  | "missing_row"
  | "null_content"
  | "path_mismatch"
  | "unpublished"

function buildLeadDeployTitle(leadRef: string, pageCount: number): string {
  const stamp = new Date().toISOString()
  const title = `pz ${leadRef} ${pageCount}p ${stamp}`
  return title.length <= DEPLOY_TITLE_MAX
    ? title
    : title.slice(0, DEPLOY_TITLE_MAX)
}

function detectStaleReason(input: {
  page: Awaited<ReturnType<typeof loadDeployLandingPage>>
  expectedPath: string
}): StaleReason | null {
  if (!input.page) return "missing_row"
  if (!input.page.html || !input.page.content_sha1) return "null_content"
  if (input.page.path !== input.expectedPath) return "path_mismatch"
  // `removed` is excluded from MANIFEST_DEPLOY_STATUSES, so such a page would
  // pass every other check yet never reach the manifest — the step would then
  // complete without the lead ever being marked deployed. Re-publishing is the
  // correct response to a deploy request for an unpublished page.
  if (input.page.deploy_status === "removed") return "unpublished"
  return null
}

async function ensureFreshLandingPage(ctx: StepContext): Promise<void> {
  const { campaignLead, campaign } = ctx.lead
  const expectedPath = landingPath(campaign.slug, campaignLead.slug)

  let staleReason = detectStaleReason({
    page: await loadDeployLandingPage(campaignLead.id),
    expectedPath,
  })
  if (!staleReason) return

  await writeDeployerLog({
    level: "info",
    message: `Stale landing page (${staleReason}); regenerating`,
    meta: {
      campaign_lead_id: campaignLead.id,
      expected_path: expectedPath,
      reason: staleReason,
    },
  })

  try {
    const note = await runPageGenerate(ctx)
    await insertPipelineEvent({
      campaignLeadId: campaignLead.id,
      kind: "note",
      step: "page",
      message: "Landing page generated.",
      meta: note,
    })
  } catch (error) {
    if (error instanceof ShutdownError || error instanceof PipelineStepError) {
      throw error
    }
    throw new PipelineStepError(
      "missing_asset",
      error instanceof Error ? error.message : String(error),
    )
  }

  staleReason = detectStaleReason({
    page: await loadDeployLandingPage(campaignLead.id),
    expectedPath,
  })
  if (staleReason) {
    throw new PipelineStepError(
      "missing_asset",
      `Landing page still unusable after regeneration (${staleReason}).`,
    )
  }
}

export type PreviousManifestPaths = {
  paths: string[] | null
  known: boolean
  source: "cache" | "seed" | "unknown"
}

/**
 * D86 — the removal guard needs the previous desired state. Prefer the Redis
 * manifest cache; on a cold cache seed from the live site listing; if Netlify's
 * /files response is unusable, proceed with `unknown` rather than guessing.
 *
 * `cachedPaths` is read from Redis when omitted — pass it explicitly (including
 * `null`) to drive this hermetically from verify:deploy.
 */
export async function resolvePreviousManifestPaths(
  client: Pick<NetlifyClient, "listSiteFiles">,
  cachedPaths?: readonly string[] | null,
): Promise<PreviousManifestPaths> {
  const cached =
    cachedPaths === undefined ? (await getManifestCache())?.paths : cachedPaths
  if (cached && cached.length > 0) {
    return { paths: [...cached], known: true, source: "cache" }
  }

  const seeded = await client.listSiteFiles()
  if (seeded) {
    return { paths: seeded, known: true, source: "seed" }
  }

  return { paths: null, known: false, source: "unknown" }
}

/**
 * The removal guard hands the unpublish to `site-sync` and waits for it. What it
 * is waiting on is a full Netlify deploy, so the budget comes from
 * `deploy.timeout_ms` rather than a fixed few seconds — the previous 5s x 3
 * ceiling expired long before any real sync could finish, which failed the
 * triggering lead every time a page was actually removed.
 *
 * Completion is observed as a new deploy id in the manifest cache.
 */
async function awaitSiteSyncCompletion(input: {
  observedDeployId: string | null
  budgetMs: number
  signal: AbortSignal
}): Promise<boolean> {
  const deadline = Date.now() + input.budgetMs

  while (Date.now() < deadline) {
    await abortableDelay(
      Math.min(REMOVAL_POLL_MS, Math.max(0, deadline - Date.now())),
      input.signal,
    )
    const cache = await getManifestCache()
    if (cache?.deploy_id && cache.deploy_id !== input.observedDeployId) {
      return true
    }
  }

  return false
}

async function runDryRunDeploy(ctx: StepContext): Promise<void> {
  const { campaignLead } = ctx.lead
  const { manifest } = await assembleManifestFromDb()
  const manifestPaths = Object.keys(manifest.files).sort()

  await writeDeployerLog({
    level: "info",
    message: "Dry-run deploy manifest assembled",
    meta: {
      manifest_paths: manifestPaths.length,
      page_count: manifest.stats.pageCount,
      retained_count: manifest.stats.retainedCount,
      bytes: totalManifestBytes(manifest),
      paths: manifestPaths,
    },
  })

  await insertPipelineEvent({
    campaignLeadId: campaignLead.id,
    kind: "note",
    step: "deploy",
    message: "Dry-run deploy — manifest validated, Netlify skipped.",
  })

  await markLeadDeployedDryRun({ campaignLeadId: campaignLead.id })
}

async function handleDeployFailure(input: {
  pageId: string | null
  campaignLeadId: string
  message: string
  netlifyBody?: string
}): Promise<never> {
  if (input.pageId) {
    await markLandingPageFailed({
      pageId: input.pageId,
      errorDetail: input.message,
    })
  }

  if (input.netlifyBody) {
    await writeDeployerLog({
      level: "error",
      message: input.message,
      meta: {
        campaign_lead_id: input.campaignLeadId,
        netlify_body: input.netlifyBody,
      },
    })
  }

  throw new PipelineStepError("netlify_failure", input.message)
}

export const deployStep: Step = {
  name: "deploy",
  async run(ctx: StepContext) {
    if (process.env.PIPELINE_STUB_STEP_MS != null) {
      await abortableDelay(readStubStepMs(), ctx.signal)
      return
    }

    const { campaignLead, campaign, lead } = ctx.lead
    const campaignLeadId = campaignLead.id
    const siteId = assertEnv().NETLIFY_SITE_ID

    await ensureFreshLandingPage(ctx)

    const settings = await resolveMany(["deploy.dry_run", "deploy.timeout_ms"])
    if (settings["deploy.dry_run"]) {
      await runDryRunDeploy(ctx)
      return
    }

    const triggerPageBefore = await loadDeployLandingPage(campaignLeadId)
    const leadRef = await loadLeadRef(lead.id)
    let siteSyncEnqueued = false

    for (let pass = 1; pass <= MAX_DEPLOY_PASSES; pass++) {
      let stopRenewal: (() => void) | null = null
      let removalRetry = false
      let observedDeployId: string | null = null
      let acquiredLock: Awaited<ReturnType<typeof acquireDeployLock>> | undefined

      try {
        acquiredLock = await (async (): Promise<
          Awaited<ReturnType<typeof acquireDeployLock>>
        > => {
          try {
            return await acquireDeployLock({ siteId, signal: ctx.signal })
          } catch (error) {
            return handleDeployFailure({
              pageId: triggerPageBefore?.id ?? null,
              campaignLeadId,
              message:
                error instanceof Error
                  ? error.message
                  : "Timed out waiting for deploy lock",
            })
          }
        })()

        stopRenewal = acquiredLock.startRenewal()
        const client = createNetlifyClient({ signal: ctx.signal })
        const previousCache = await getManifestCache()
        const previousPaths = await resolvePreviousManifestPaths(client)

        const { manifest, pages } = await assembleManifestFromDb()
        const manifestPaths = Object.keys(manifest.files).sort()
        const triggerPageInManifest = pages.find(
          (page) => page.campaign_lead_id === campaignLeadId,
        )
        const triggerPage = triggerPageInManifest ?? triggerPageBefore

        // Without this the lead would deploy "successfully" while its own page
        // sat outside the manifest — the reconcile would never touch it and the
        // lead would silently never reach `deployed`.
        if (!triggerPageInManifest) {
          throw new PipelineStepError(
            "missing_asset",
            `Landing page for this lead is not in the deploy manifest (expected ${landingPath(campaign.slug, campaignLead.slug)}).`,
          )
        }

        if (previousPaths.known && previousPaths.paths) {
          const diff = diffPaths(previousPaths.paths, manifestPaths)
          if (diff.removed.length > 0) {
            if (!siteSyncEnqueued) {
              await enqueueSiteSync()
              siteSyncEnqueued = true
            }
            await writeDeployerLog({
              level: "warn",
              message: "Removal guard detected unpublished paths; re-passing",
              meta: {
                campaign_lead_id: campaignLeadId,
                removed_count: diff.removed.length,
                removed_paths: diff.removed.slice(0, 20),
                pass,
              },
            })
            observedDeployId = previousCache?.deploy_id ?? null
            removalRetry = true
          }
        } else {
          await writeDeployerLog({
            level: "info",
            message: "Deploy proceeding with previous_paths: unknown",
            meta: { campaign_lead_id: campaignLeadId, pass },
          })
        }

        if (!removalRetry) {
          const currentHash = manifestHash(manifest.files)
          const canSkip =
            previousCache != null &&
            previousCache.sha === currentHash &&
            previousCache.deploy_id != null &&
            triggerPage?.deploy_status === "live"

          let deployId: string
          let siteUrl: string
          let requiredCount: number | undefined
          let uploadedCount: number | undefined

          if (canSkip) {
            deployId = previousCache!.deploy_id
            siteUrl = (await client.getSiteUrl()).replace(/\/$/, "")
            await writeDeployerLog({
              level: "info",
              message: "Deploy skipped — manifest hash unchanged",
              meta: {
                campaign_lead_id: campaignLeadId,
                deploy_id: deployId,
                manifest_paths: manifestPaths.length,
              },
            })
          } else {
            let published: Awaited<ReturnType<typeof publishManifest>>
            try {
              published = await publishManifest({
                manifest,
                pages,
                title: buildLeadDeployTitle(leadRef, manifest.stats.pageCount),
                signal: ctx.signal,
              })
            } catch (error) {
              if (error instanceof SiteOwnershipError) {
                await setDeployDirty(siteId)
                throw error
              }
              const message =
                error instanceof Error ? error.message : String(error)
              const netlifyBody =
                error instanceof NetlifyError ? error.body : undefined
              await handleDeployFailure({
                pageId: triggerPage?.id ?? null,
                campaignLeadId,
                message,
                netlifyBody,
              })
            }
            deployId = published!.deployId
            siteUrl = published!.siteUrl.replace(/\/$/, "")
            requiredCount = published!.requiredCount
            uploadedCount = published!.uploadedCount
          }

          // Netlify is live at this point. A bookkeeping error here must not be
          // reported as a deploy failure — that would mark a serving page
          // `failed` and fail the lead. Flag the site dirty so a site-sync
          // re-runs the reconcile, and let the lead finish.
          try {
            await reconcileManifestDeploy({
              manifest,
              pages,
              deployId,
              siteUrl,
              previousCache,
              requiredCount,
              uploadedCount,
            })
          } catch (reconcileError) {
            await setDeployDirty(siteId)
            await enqueueSiteSync()
            await writeDeployerLog({
              level: "error",
              message:
                "Deploy landed but post-deploy reconcile failed; site-sync queued to retry",
              meta: {
                campaign_lead_id: campaignLeadId,
                deploy_id: deployId,
                error:
                  reconcileError instanceof Error
                    ? reconcileError.message
                    : String(reconcileError),
              },
            })
          }

          const triggerNetlifyUrl = `${siteUrl}${landingPath(campaign.slug, campaignLead.slug)}`
          await insertPipelineEvent({
            campaignLeadId,
            kind: "deployed",
            step: "deploy",
            message: `Deployed to ${triggerNetlifyUrl}`,
          })

          try {
            const cleanup = await cleanupLocalWebMp4(campaignLeadId)
            if (cleanup.removed) {
              await writeDeployerLog({
                level: "info",
                message: "Removed local web.mp4 after deploy",
                meta: {
                  campaign_lead_id: campaignLeadId,
                  path: cleanup.path,
                },
              })
            }
          } catch (error) {
            await writeDeployerLog({
              level: "warn",
              message: "Failed to remove local web.mp4 (non-fatal)",
              meta: {
                campaign_lead_id: campaignLeadId,
                error:
                  error instanceof Error ? error.message : String(error),
              },
            })
          }

          return
        }
      } catch (error) {
        if (error instanceof ManifestDuplicatePathError) {
          await handleDeployFailure({
            pageId: triggerPageBefore?.id ?? null,
            campaignLeadId,
            message: error.message,
          })
        }
        if (error instanceof SiteOwnershipError) {
          throw error
        }
        if (error instanceof PipelineStepError) {
          throw error
        }
        if (error instanceof ShutdownError) {
          throw error
        }
        await handleDeployFailure({
          pageId: triggerPageBefore?.id ?? null,
          campaignLeadId,
          message: error instanceof Error ? error.message : String(error),
        })
      } finally {
        stopRenewal?.()
        await acquiredLock?.release()
      }

      if (removalRetry) {
        const synced = await awaitSiteSyncCompletion({
          observedDeployId,
          budgetMs: settings["deploy.timeout_ms"],
          signal: ctx.signal,
        })
        if (!synced) {
          await handleDeployFailure({
            pageId: triggerPageBefore?.id ?? null,
            campaignLeadId,
            message: `Removal guard timed out after ${settings["deploy.timeout_ms"]}ms waiting for site-sync`,
          })
        }
        continue
      }
    }

    await handleDeployFailure({
      pageId: triggerPageBefore?.id ?? null,
      campaignLeadId,
      message: `Removal guard exhausted after ${MAX_DEPLOY_PASSES} passes`,
    })
  },
}
