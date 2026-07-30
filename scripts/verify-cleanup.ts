/**
 * Phase 16 cleanup verification — real Supabase, temp LOCAL_STORAGE_ROOT.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import type { Database } from "../lib/database.types"

interface CheckResult {
  name: string
  state: "pass" | "fail" | "skip"
  detail: string
}

const results: CheckResult[] = []
const VALID_SHA1 = "0123456789abcdef0123456789abcdef01234567"
const FIXED_NOW = new Date("2026-07-30T12:00:00.000Z")
const STALE_ISO = "2026-07-25T12:00:00.000Z"
const FRESH_ISO = "2026-07-30T10:00:00.000Z"

function pass(name: string, detail = "ok"): void {
  results.push({ name, state: "pass", detail })
  console.log(`PASS  ${name}${detail === "ok" ? "" : ` — ${detail}`}`)
}

function fail(name: string, detail: string): void {
  results.push({ name, state: "fail", detail })
  console.error(`FAIL  ${name} — ${detail}`)
  process.exitCode = 1
}

function skip(name: string, reason: string): void {
  results.push({ name, state: "skip", detail: reason })
  console.log(`SKIP  ${name} — ${reason}`)
}

async function main(): Promise<void> {
  const previousStorageRoot = process.env.LOCAL_STORAGE_ROOT
  const tempStorageRoot = mkdtempSync(path.join(tmpdir(), "pz-cleanup-verify-"))
  process.env.LOCAL_STORAGE_ROOT = tempStorageRoot

  const { createClient } = await import("@supabase/supabase-js")
  const { assertEnvOrExit } = await import("../lib/env-node")
  const { resetEnvCache } = await import("../lib/env")
  const { runCleanupSweeps } = await import("../worker/cleanup/sweeps")
  const { evaluateRecordingPrecheck } = await import("../lib/recording-precheck")
  const { deleteContainedRelPath } = await import("../lib/local-file")
  const { probeRedisHealth, closeHealthRedis } = await import("../lib/queue-health")
  const { upsertSettings } = await import("../lib/settings-admin")

  resetEnvCache()
  const env = assertEnvOrExit()
  const supabase = createClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } },
  )

  const runId = Date.now().toString(36)
  const batchId = `verify-${runId}`
  let campaignId: string | null = null
  const leadIds: string[] = []

  const writeFixtureFile = (relPath: string, content = "fixture"): void => {
    const abs = path.join(tempStorageRoot, ...relPath.split("/").filter(Boolean))
    mkdirSync(path.dirname(abs), { recursive: true })
    writeFileSync(abs, content)
  }

  const fixtureAbs = (relPath: string): string =>
    path.join(tempStorageRoot, ...relPath.split("/").filter(Boolean))

  async function seedCampaignLead(input: {
    slug: string
    company: string
    status?: Database["public"]["Enums"]["lead_status"]
    netlifyUrl?: string | null
    deployedDryRun?: boolean
    errorCode?: Database["public"]["Enums"]["error_code"]
  }): Promise<{ leadId: string; campaignLeadId: string }> {
    const { data: lead, error: leadError } = await supabase
      .from("leads")
      .insert({
        company: input.company,
        domain: `${input.slug}.example.com`,
      })
      .select("id")
      .single()
    if (leadError || !lead) throw new Error(leadError?.message ?? "lead insert")

    leadIds.push(lead.id)

    const { data: cl, error: clError } = await supabase
      .from("campaign_leads")
      .insert({
        campaign_id: campaignId!,
        lead_id: lead.id,
        slug: input.slug,
        status: input.status ?? "deployed",
        current_step: "deploy",
        netlify_url: input.netlifyUrl ?? "https://example.com/fixture",
        deployed_dry_run: input.deployedDryRun ?? false,
        ...(input.errorCode
          ? { error_code: input.errorCode, error_detail: "verify cleanup fixture" }
          : {}),
      })
      .select("id")
      .single()
    if (clError || !cl) throw new Error(clError?.message ?? "campaign_lead insert")

    return { leadId: lead.id, campaignLeadId: cl.id }
  }

  const fixture: Record<string, string> = {}

  try {
    const { data: campaign, error: campaignError } = await supabase
      .from("campaigns")
      .insert({
        name: `Verify Cleanup ${runId}`,
        slug: `verify-cleanup-${runId}`,
        description: "phase 16 fixture",
        landing_template: "<html></html>",
        merge_layout: "bubble_br",
        pip_scale: 0.2,
        viewport_width: 1920,
        viewport_height: 1080,
        nav_timeout_ms: 120_000,
      })
      .select("id")
      .single()
    if (campaignError || !campaign) {
      fail("seed campaign", campaignError?.message ?? "no row")
      return
    }
    campaignId = campaign.id

    // ---- Sweep 1 fixtures -------------------------------------------------
    const purgeSlug = `purge-${runId}`
    const purgeLead = await seedCampaignLead({
      slug: purgeSlug,
      company: `Purge ${runId}`,
    })
    const purgeRelPath = `${batchId}/${purgeSlug}/recording.mp4`
    writeFixtureFile(purgeRelPath)
    const { data: purgeRec, error: purgeRecError } = await supabase
      .from("recordings")
      .insert({
        lead_id: purgeLead.leadId,
        local_path: purgeRelPath,
        recorded_at: STALE_ISO,
        file_size_bytes: 7,
      })
      .select("id")
      .single()
    if (purgeRecError || !purgeRec) {
      fail("seed purge recording", purgeRecError?.message ?? "no row")
      return
    }
    fixture.purgeRecordingId = purgeRec.id
    fixture.purgeRelPath = purgeRelPath

    const goneSlug = `gone-${runId}`
    const goneLead = await seedCampaignLead({
      slug: goneSlug,
      company: `Gone ${runId}`,
    })
    const goneRelPath = `${batchId}/${goneSlug}/recording.mp4`
    const { data: goneRec, error: goneRecError } = await supabase
      .from("recordings")
      .insert({
        lead_id: goneLead.leadId,
        local_path: goneRelPath,
        recorded_at: STALE_ISO,
      })
      .select("id")
      .single()
    if (goneRecError || !goneRec) {
      fail("seed gone recording", goneRecError?.message ?? "no row")
      return
    }
    fixture.goneRecordingId = goneRec.id

    const failedInsertLead = await seedCampaignLead({
      slug: `failed-insert-${runId}`,
      company: `Failed insert ${runId}`,
      status: "failed",
      errorCode: "nav_timeout",
    })
    const { data: failedInsertRec, error: failedInsertError } = await supabase
      .from("recordings")
      .insert({
        lead_id: failedInsertLead.leadId,
        local_path: null,
        error_code: "nav_timeout",
        recorded_at: STALE_ISO,
      })
      .select("id")
      .single()
    if (failedInsertError || !failedInsertRec) {
      fail("seed failed-insert recording", failedInsertError?.message ?? "no row")
      return
    }
    fixture.failedInsertRecordingId = failedInsertRec.id

    const missingAssetLead = await seedCampaignLead({
      slug: `missing-${runId}`,
      company: `Missing asset ${runId}`,
    })
    const { data: missingAssetRec, error: missingAssetError } = await supabase
      .from("recordings")
      .insert({
        lead_id: missingAssetLead.leadId,
        local_path: null,
        purged_at: null,
        recorded_at: STALE_ISO,
      })
      .select("id")
      .single()
    if (missingAssetError || !missingAssetRec) {
      fail("seed missing-asset recording", missingAssetError?.message ?? "no row")
      return
    }
    fixture.missingAssetRecordingId = missingAssetRec.id

    // ---- Sweep 2 fixtures -------------------------------------------------
    const liveWebSlug = `live-web-${runId}`
    const liveDeployLead = await seedCampaignLead({
      slug: liveWebSlug,
      company: `Live web ${runId}`,
      status: "deployed",
      netlifyUrl: "https://example.com/live-web",
    })
    const liveWebPath = `${batchId}/${liveWebSlug}/web.mp4`
    writeFixtureFile(liveWebPath)
    const { data: liveVideo, error: liveVideoError } = await supabase
      .from("videos")
      .insert({
        campaign_lead_id: liveDeployLead.campaignLeadId,
        web_path: liveWebPath,
        web_public_url: "https://cdn.example.com/live-web.mp4",
        uploaded_at: STALE_ISO,
        used_speed_floor: false,
      })
      .select("id")
      .single()
    if (liveVideoError || !liveVideo) {
      fail("seed live web video", liveVideoError?.message ?? "no row")
      return
    }
    fixture.liveWebPath = liveWebPath
    await supabase.from("landing_pages").insert({
      campaign_lead_id: liveDeployLead.campaignLeadId,
      path: `/verify-live-web-${runId}`,
      deploy_status: "live",
      deployed_at: STALE_ISO,
      html: "<html></html>",
      content_sha1: VALID_SHA1,
    })

    const dryWebSlug = `dry-web-${runId}`
    const dryRunLead = await seedCampaignLead({
      slug: dryWebSlug,
      company: `Dry web ${runId}`,
      status: "deployed",
      netlifyUrl: null,
      deployedDryRun: true,
    })
    const dryWebPath = `${batchId}/${dryWebSlug}/web.mp4`
    writeFixtureFile(dryWebPath)
    const { error: dryVideoError } = await supabase.from("videos").insert({
      campaign_lead_id: dryRunLead.campaignLeadId,
      web_path: dryWebPath,
      web_public_url: "https://cdn.example.com/dry-web.mp4",
      uploaded_at: STALE_ISO,
      used_speed_floor: false,
    })
    if (dryVideoError) {
      fail("seed dry-run web video", dryVideoError.message)
      return
    }
    fixture.dryWebPath = dryWebPath
    await supabase.from("landing_pages").insert({
      campaign_lead_id: dryRunLead.campaignLeadId,
      path: `/verify-dry-web-${runId}`,
      deploy_status: "live",
      deployed_at: null,
      html: "<html></html>",
      content_sha1: VALID_SHA1,
    })

    // ---- Sweep 3 fixtures -------------------------------------------------
    const pruneSlug = `prune-shots-${runId}`
    const pruneLead = await seedCampaignLead({
      slug: pruneSlug,
      company: `Prune shots ${runId}`,
    })
    const pruneBefore = `${batchId}/${pruneSlug}/screenshot-before.png`
    const pruneAfter = `${batchId}/${pruneSlug}/screenshot-after.png`
    writeFixtureFile(pruneBefore, "png-before")
    writeFixtureFile(pruneAfter, "png-after")
    const { error: pruneRecError } = await supabase.from("recordings").insert({
      lead_id: pruneLead.leadId,
      local_path: `${batchId}/${pruneSlug}/recording.mp4`,
      recorded_at: STALE_ISO,
      created_at: STALE_ISO,
      screenshot_before_path: pruneBefore,
      screenshot_after_path: pruneAfter,
    })
    if (pruneRecError) {
      fail("seed prune-screenshots recording", pruneRecError.message)
      return
    }
    fixture.pruneBefore = pruneBefore
    fixture.pruneAfter = pruneAfter

    const failedShotSlug = `failed-shots-${runId}`
    const failedLead = await seedCampaignLead({
      slug: failedShotSlug,
      company: `Failed shots ${runId}`,
      status: "failed",
      errorCode: "nav_timeout",
    })
    const failedBefore = `${batchId}/${failedShotSlug}/screenshot-before.png`
    writeFixtureFile(failedBefore, "png-failed")
    const { error: failedShotError } = await supabase.from("recordings").insert({
      lead_id: failedLead.leadId,
      local_path: `${batchId}/${failedShotSlug}/recording.mp4`,
      recorded_at: STALE_ISO,
      created_at: STALE_ISO,
      screenshot_before_path: failedBefore,
    })
    if (failedShotError) {
      fail("seed failed-screenshots recording", failedShotError.message)
      return
    }
    fixture.failedBefore = failedBefore

    const recapturedSlug = `recaptured-${runId}`
    const recapturedLead = await seedCampaignLead({
      slug: recapturedSlug,
      company: `Recaptured ${runId}`,
    })
    const oldBefore = `${batchId}/${recapturedSlug}/old-before.png`
    const newBefore = `${batchId}/${recapturedSlug}/new-before.png`
    writeFixtureFile(oldBefore, "png-old")
    writeFixtureFile(newBefore, "png-new")
    const { data: oldRecapturedRec, error: oldRecError } = await supabase
      .from("recordings")
      .insert({
        lead_id: recapturedLead.leadId,
        local_path: `${batchId}/${recapturedSlug}/old-recording.mp4`,
        recorded_at: STALE_ISO,
        created_at: STALE_ISO,
        screenshot_before_path: oldBefore,
      })
      .select("id")
      .single()
    if (oldRecError || !oldRecapturedRec) {
      fail("seed recaptured old recording", oldRecError?.message ?? "no row")
      return
    }
    await supabase
      .from("recordings")
      .update({
        purged_at: STALE_ISO,
        local_path: null,
      })
      .eq("id", oldRecapturedRec.id)
    const { error: newRecError } = await supabase.from("recordings").insert({
      lead_id: recapturedLead.leadId,
      local_path: `${batchId}/${recapturedSlug}/new-recording.mp4`,
      recorded_at: FRESH_ISO,
      created_at: FRESH_ISO,
      screenshot_before_path: newBefore,
    })
    if (newRecError) {
      fail("seed recaptured new recording", newRecError.message)
      return
    }
    fixture.oldBefore = oldBefore
    fixture.newBefore = newBefore

    const unionSlug = `union-shots-${runId}`
    const unionLead = await seedCampaignLead({
      slug: unionSlug,
      company: `Union shots ${runId}`,
    })
    const unionBeforeA = `${batchId}/${unionSlug}/before-a.png`
    const unionBeforeB = `${batchId}/${unionSlug}/before-b.png`
    writeFixtureFile(unionBeforeA, "png-a")
    writeFixtureFile(unionBeforeB, "png-b")
    const { data: unionOldRec, error: unionOldError } = await supabase
      .from("recordings")
      .insert({
        lead_id: unionLead.leadId,
        local_path: `${batchId}/${unionSlug}/old-recording.mp4`,
        recorded_at: STALE_ISO,
        created_at: STALE_ISO,
        screenshot_before_path: unionBeforeA,
      })
      .select("id")
      .single()
    if (unionOldError || !unionOldRec) {
      fail("seed union-screenshots old recording", unionOldError?.message ?? "no row")
      return
    }
    await supabase
      .from("recordings")
      .update({ purged_at: STALE_ISO, local_path: null })
      .eq("id", unionOldRec.id)
    const { error: unionOlderError } = await supabase.from("recordings").insert({
      lead_id: unionLead.leadId,
      local_path: `${batchId}/${unionSlug}/older-recording.mp4`,
      recorded_at: STALE_ISO,
      created_at: "2026-07-20T12:00:00.000Z",
      screenshot_before_path: unionBeforeB,
    })
    if (unionOlderError) {
      fail("seed union-screenshots older recording", unionOlderError.message)
      return
    }
    fixture.unionBeforeA = unionBeforeA
    fixture.unionBeforeB = unionBeforeB

    const busyShotSlug = `busy-shots-${runId}`
    const busyShotLead = await seedCampaignLead({
      slug: busyShotSlug,
      company: `Busy shots ${runId}`,
      status: "processing",
    })
    const busyShotBefore = `${batchId}/${busyShotSlug}/screenshot-before.png`
    writeFixtureFile(busyShotBefore, "png-busy")
    const { error: busyShotRecError } = await supabase.from("recordings").insert({
      lead_id: busyShotLead.leadId,
      local_path: null,
      purged_at: STALE_ISO,
      recorded_at: STALE_ISO,
      created_at: STALE_ISO,
      screenshot_before_path: busyShotBefore,
    })
    if (busyShotRecError) {
      fail("seed busy-screenshots recording", busyShotRecError.message)
      return
    }
    fixture.busyShotBefore = busyShotBefore

    pass("seed fixtures")

    // ---- Wrapper: cutoff below 1 refuses -----------------------------------
    const refuseBeforeExists = existsSync(fixtureAbs(fixture.purgeRelPath!))
    const refuse = await runCleanupSweeps({
      supabase,
      recDays: 0,
      shotDays: 1,
      now: () => FIXED_NOW,
    })
    const refuseAfterExists = existsSync(fixtureAbs(fixture.purgeRelPath!))
    if (
      refuse.counts.recordingsPurged === 0 &&
      refuse.counts.webCopiesDeleted === 0 &&
      refuse.counts.screenshotFilesDeleted === 0 &&
      refuseBeforeExists &&
      refuseAfterExists
    ) {
      pass("cutoff below 1 refuses and deletes nothing")
    } else {
      fail(
        "cutoff below 1 refuses and deletes nothing",
        JSON.stringify({
          counts: refuse.counts,
          refuseBeforeExists,
          refuseAfterExists,
        }),
      )
    }

    // ---- Sweep 1: precheck + error_code visibility -------------------------
    const missingPrecheck = await evaluateRecordingPrecheck({
      recording: {
        id: fixture.missingAssetRecordingId!,
        local_path: null,
        purged_at: null,
      },
      forcedRerecord: false,
    })
    if (missingPrecheck.action === "missing_asset") {
      pass("missing-not-purged classifies as missing_asset")
    } else {
      fail("missing-not-purged classifies as missing_asset", missingPrecheck.action)
    }

    // ---- Main sweeps -------------------------------------------------------
    const sweep = await runCleanupSweeps({
      supabase,
      recDays: 1,
      shotDays: 1,
      now: () => FIXED_NOW,
    })

    if (sweep.bytesFreed >= 7) {
      pass("bytesFreed accumulates purged recording bytes")
    } else {
      fail("bytesFreed accumulates purged recording bytes", String(sweep.bytesFreed))
    }

    const { data: purgedRow } = await supabase
      .from("recordings")
      .select("purged_at, local_path")
      .eq("id", fixture.purgeRecordingId!)
      .single()
    if (
      !existsSync(fixtureAbs(fixture.purgeRelPath!)) &&
      purgedRow?.purged_at != null &&
      purgedRow.local_path == null
    ) {
      pass("purge deletes the file and sets purged_at")
    } else {
      fail(
        "purge deletes the file and sets purged_at",
        JSON.stringify({ purgedRow, fileExists: existsSync(fixtureAbs(fixture.purgeRelPath!)) }),
      )
    }

    const { data: goneRow } = await supabase
      .from("recordings")
      .select("purged_at, local_path")
      .eq("id", fixture.goneRecordingId!)
      .single()
    if (goneRow?.purged_at != null && goneRow.local_path == null) {
      pass("purge treats an already-missing file as done")
    } else {
      fail("purge treats an already-missing file as done", JSON.stringify(goneRow))
    }

    const { data: failedInsertRow } = await supabase
      .from("recordings")
      .select("purged_at, local_path, error_code")
      .eq("id", fixture.failedInsertRecordingId!)
      .single()
    if (
      failedInsertRow?.purged_at == null &&
      failedInsertRow?.local_path == null &&
      failedInsertRow?.error_code === "nav_timeout"
    ) {
      pass("purge never sees an error_code row")
    } else {
      fail("purge never sees an error_code row", JSON.stringify(failedInsertRow))
    }

    const sweptPrecheck = await evaluateRecordingPrecheck({
      recording: {
        id: fixture.purgeRecordingId!,
        local_path: purgedRow?.local_path ?? null,
        purged_at: purgedRow?.purged_at ?? null,
      },
      forcedRerecord: false,
    })
    if (sweptPrecheck.action === "record_purged") {
      pass("swept row classifies as record_purged")
    } else {
      fail("swept row classifies as record_purged", sweptPrecheck.action)
    }

    const casSlug = `cas-${runId}`
    const casLead = await seedCampaignLead({
      slug: casSlug,
      company: `CAS ${runId}`,
    })
    const casPathA = `${batchId}/${casSlug}/recording-a.mp4`
    const casPathB = `${batchId}/${casSlug}/recording-b.mp4`
    writeFixtureFile(casPathA)
    const { data: casRec, error: casRecError } = await supabase
      .from("recordings")
      .insert({
        lead_id: casLead.leadId,
        local_path: casPathA,
        recorded_at: STALE_ISO,
      })
      .select("id")
      .single()
    if (casRecError || !casRec) {
      fail("seed CAS recording", casRecError?.message ?? "no row")
    } else {
      const casResult = await runCleanupSweeps({
        supabase,
        recDays: 1,
        shotDays: 365,
        now: () => FIXED_NOW,
        deleteFile: async (relPath) => {
          const outcome = await deleteContainedRelPath(relPath)
          if (relPath === casPathA) {
            await supabase
              .from("recordings")
              .update({ local_path: casPathB })
              .eq("id", casRec.id)
          }
          return outcome
        },
      })
      const { data: casRow } = await supabase
        .from("recordings")
        .select("local_path, purged_at")
        .eq("id", casRec.id)
        .single()
      if (
        casResult.counts.recordingsSkippedRevived >= 1 &&
        casRow?.local_path === casPathB &&
        casRow.purged_at == null
      ) {
        pass("purge CAS skips a revived row")
      } else {
        fail(
          "purge CAS skips a revived row",
          JSON.stringify({ counts: casResult.counts, casRow }),
        )
      }
    }

    // ---- Sweep 2 -----------------------------------------------------------
    const { data: liveVideoRow } = await supabase
      .from("videos")
      .select("web_path")
      .eq("campaign_lead_id", liveDeployLead.campaignLeadId)
      .single()
    if (
      !existsSync(fixtureAbs(fixture.liveWebPath!)) &&
      liveVideoRow?.web_path == null
    ) {
      pass("web copy deleted after a live deploy")
    } else {
      fail(
        "web copy deleted after a live deploy",
        JSON.stringify({
          web_path: liveVideoRow?.web_path,
          exists: existsSync(fixtureAbs(fixture.liveWebPath!)),
        }),
      )
    }

    const { data: dryVideoRow } = await supabase
      .from("videos")
      .select("web_path")
      .eq("campaign_lead_id", dryRunLead.campaignLeadId)
      .single()
    if (
      existsSync(fixtureAbs(fixture.dryWebPath!)) &&
      dryVideoRow?.web_path === fixture.dryWebPath
    ) {
      pass("web copy spared for dry-run lead")
    } else {
      fail(
        "web copy spared for dry-run lead",
        JSON.stringify({
          web_path: dryVideoRow?.web_path,
          exists: existsSync(fixtureAbs(fixture.dryWebPath!)),
        }),
      )
    }

    // ---- Sweep 3 -----------------------------------------------------------
    if (
      !existsSync(fixtureAbs(fixture.pruneBefore!)) &&
      !existsSync(fixtureAbs(fixture.pruneAfter!))
    ) {
      pass("failed-only lead prunes PNGs when no failed campaign_lead")
    } else {
      fail(
        "failed-only lead prunes PNGs when no failed campaign_lead",
        `before=${existsSync(fixtureAbs(fixture.pruneBefore!))} after=${existsSync(fixtureAbs(fixture.pruneAfter!))}`,
      )
    }

    if (existsSync(fixtureAbs(fixture.failedBefore!))) {
      pass("lead with failed campaign_lead is spared")
    } else {
      fail("lead with failed campaign_lead is spared", "screenshot file deleted")
    }

    if (
      existsSync(fixtureAbs(fixture.oldBefore!)) &&
      existsSync(fixtureAbs(fixture.newBefore!))
    ) {
      pass("recaptured lead is not pruned")
    } else {
      fail(
        "recaptured lead is not pruned",
        `old=${existsSync(fixtureAbs(fixture.oldBefore!))} new=${existsSync(fixtureAbs(fixture.newBefore!))}`,
      )
    }

    if (
      !existsSync(fixtureAbs(fixture.unionBeforeA!)) &&
      !existsSync(fixtureAbs(fixture.unionBeforeB!))
    ) {
      pass("screenshot union deletes every stale path on a lead")
    } else {
      fail(
        "screenshot union deletes every stale path on a lead",
        `a=${existsSync(fixtureAbs(fixture.unionBeforeA!))} b=${existsSync(fixtureAbs(fixture.unionBeforeB!))}`,
      )
    }

    if (existsSync(fixtureAbs(fixture.busyShotBefore!))) {
      pass("processing lead with purged recording spares screenshots")
    } else {
      fail(
        "processing lead with purged recording spares screenshots",
        "screenshot file deleted",
      )
    }

    if (sweep.counts.errors === 0) {
      pass("main sweep zero errors")
    } else {
      fail("main sweep zero errors", JSON.stringify(sweep.errorSamples))
    }

    // ---- Redis legs --------------------------------------------------------
    if ((await probeRedisHealth()) === "down") {
      skip("lock held skips cleanup with locked summary", "redis not reachable")
      skip("runCleanupJob writes last-run summary", "redis not reachable")
    } else {
      const { acquireRedisLock } = await import("../lib/redis-lock")
      const {
        CLEANUP_LOCK_KEY,
        runCleanupJob,
        getCleanupLastRun,
      } = await import("../worker/cleanup/job")

      const heldLock = await acquireRedisLock({
        key: CLEANUP_LOCK_KEY,
        ttlMs: 30_000,
        renewMs: 10_000,
        waitMs: 0,
      })
      if (!heldLock) {
        fail("lock held skips cleanup with locked summary", "could not acquire lock")
      } else {
        try {
          await runCleanupJob({ trigger: "manual" })
          const lockedSummary = await getCleanupLastRun()
          if (lockedSummary?.skipped === "locked") {
            pass("lock held skips cleanup with locked summary")
          } else {
            fail(
              "lock held skips cleanup with locked summary",
              JSON.stringify(lockedSummary),
            )
          }
        } finally {
          await heldLock.release()
        }
      }

      await upsertSettings([
        { key: "cleanup.dry_run", value: true },
        { key: "cleanup.enabled", value: true },
      ])
      await runCleanupJob({ trigger: "manual" })
      const summary = await getCleanupLastRun()
      if (summary?.ok === true && summary.dryRun === true) {
        pass("runCleanupJob writes last-run summary")
      } else {
        fail("runCleanupJob writes last-run summary", JSON.stringify(summary))
      }
    }
  } catch (error) {
    fail("verify:cleanup unexpected", (error as Error).message)
  } finally {
    for (const id of leadIds) {
      await supabase.from("leads").delete().eq("id", id)
    }
    if (campaignId) {
      await supabase.from("campaigns").delete().eq("id", campaignId)
    }

    let strayLeads = 0
    if (leadIds.length > 0) {
      const { count } = await supabase
        .from("leads")
        .select("*", { count: "exact", head: true })
        .in("id", leadIds)
      strayLeads = count ?? 0
    }

    const storageGone = !existsSync(tempStorageRoot)
    rmSync(tempStorageRoot, { recursive: true, force: true })

    if (previousStorageRoot === undefined) {
      delete process.env.LOCAL_STORAGE_ROOT
    } else {
      process.env.LOCAL_STORAGE_ROOT = previousStorageRoot
    }
    resetEnvCache()

    if (strayLeads === 0 && !existsSync(tempStorageRoot)) {
      pass("teardown leads / storage root")
    } else {
      fail(
        "teardown leads / storage root",
        `strayLeads=${strayLeads} storageGone=${storageGone}`,
      )
    }

    await closeHealthRedis()
  }

  const passed = results.filter((r) => r.state === "pass").length
  const skipped = results.filter((r) => r.state === "skip").length
  const failed = results.filter((r) => r.state === "fail").length
  const asserted = results.length - skipped
  console.log(
    `\n${passed}/${asserted} checks passed${skipped > 0 ? `, ${skipped} skipped` : ""}`,
  )
  if (failed > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
