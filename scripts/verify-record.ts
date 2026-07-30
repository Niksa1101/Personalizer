/**
 * Phase 8 recorder verification — fixture leg (hermetic) + optional real-site leg.
 *
 * Fixture leg runs in CI. Real-site leg requires RECORD_REAL=1 and network access.
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { classifyFailure } from "../lib/pipeline-retry"
import { evaluateRecordingPrecheck, PURGED_RERECORD_NOTE } from "../lib/recording-precheck"
import { PipelineStepError } from "../lib/pipeline-types"
import { assertEnvOrExit } from "../lib/env-node"
import { MIN_SCROLL_DURATION_MS, MAX_SCROLL_DURATION_MS } from "../worker/recorder/scroll"
import { classifyCaptureError } from "../worker/recorder/classify"
import {
  CaptureFailedError,
  captureRecording,
} from "../worker/recorder"
import { closeSharedBrowser } from "../worker/recorder/browser"

import { startFixtureServer } from "./fixtures/record/fixture-server"

interface CheckResult {
  name: string
  ok: boolean
  detail: string
}

const results: CheckResult[] = []

function pass(name: string, detail = "ok"): void {
  results.push({ name, ok: true, detail })
  console.log(`PASS  ${name}${detail === "ok" ? "" : ` — ${detail}`}`)
}

function fail(name: string, detail: string): void {
  results.push({ name, ok: false, detail })
  console.error(`FAIL  ${name} — ${detail}`)
}

async function withTempStorageRoot<T>(fn: () => Promise<T>): Promise<T> {
  const previous = process.env.LOCAL_STORAGE_ROOT
  const tempRoot = mkdtempSync(path.join(tmpdir(), "pz-record-verify-"))
  process.env.LOCAL_STORAGE_ROOT = tempRoot

  try {
    return await fn()
  } finally {
    if (previous === undefined) {
      delete process.env.LOCAL_STORAGE_ROOT
    } else {
      process.env.LOCAL_STORAGE_ROOT = previous
    }
    rmSync(tempRoot, { recursive: true, force: true })
  }
}

async function runFixtureLeg(): Promise<void> {
  if (classifyCaptureError({
    url: "http://127.0.0.1/parked",
    page: {
      innerTextLength: 500,
      scrollHeight: 1080,
      viewportHeight: 1080,
      finalUrl: "http://127.0.0.1/parked",
      bodyHtml: "<html><body>This domain is for sale</body></html>",
    },
  }) === "parked_domain") {
    pass("classify parked fixture")
  } else {
    fail("classify parked fixture", "expected parked_domain")
  }

  if (classifyCaptureError({
    url: "http://127.0.0.1/empty",
    page: {
      innerTextLength: 0,
      scrollHeight: 800,
      viewportHeight: 1080,
      finalUrl: "http://127.0.0.1/empty",
      bodyHtml: "<html><body></body></html>",
    },
  }) === "empty_page") {
    pass("classify empty fixture")
  } else {
    fail("classify empty fixture", "expected empty_page")
  }

  if (classifyCaptureError({
    url: "http://127.0.0.1/login",
    page: {
      innerTextLength: 500,
      scrollHeight: 1080,
      viewportHeight: 1080,
      finalUrl: "http://127.0.0.1/login?next=/",
      bodyHtml: "<html><body>Login</body></html>",
    },
  }) === "login_required") {
    pass("classify login fixture")
  } else {
    fail("classify login fixture", "expected login_required")
  }

  const reuseFresh = await evaluateRecordingPrecheck({
    recording: {
      id: "rec-1",
      local_path: "batch/acme/recording.mp4",
      purged_at: null,
    },
    forcedRerecord: false,
    statFile: async () => ({ exists: true }),
  })
  if (reuseFresh.action === "reuse") {
    pass("reuse precheck selects existing recording")
  } else {
    fail("reuse precheck selects existing recording", reuseFresh.action)
  }

  const secondRun = await evaluateRecordingPrecheck({
    recording: {
      id: "rec-1",
      local_path: "batch/acme/recording.mp4",
      purged_at: null,
    },
    forcedRerecord: false,
    statFile: async () => ({ exists: true }),
  })
  if (secondRun.action === "reuse") {
    pass("second run reuses without re-capture")
  } else {
    fail("second run reuses without re-capture", secondRun.action)
  }

  const purgedPrecheck = await evaluateRecordingPrecheck({
    recording: {
      id: "rec-purged",
      local_path: "batch/acme/recording.mp4",
      purged_at: "2026-01-01T00:00:00Z",
    },
    forcedRerecord: false,
    statFile: async () => ({ exists: false }),
  })
  if (
    purgedPrecheck.action === "record_purged" &&
    purgedPrecheck.recordingId === "rec-purged"
  ) {
    pass("precheck classifies a purged row as record_purged")
  } else {
    fail(
      "precheck classifies a purged row as record_purged",
      purgedPrecheck.action,
    )
  }

  const missingPrecheck = await evaluateRecordingPrecheck({
    recording: {
      id: "rec-missing",
      local_path: "batch/acme/recording.mp4",
      purged_at: null,
    },
    forcedRerecord: false,
    statFile: async () => ({ exists: false }),
  })
  if (missingPrecheck.action === "missing_asset") {
    pass("precheck classifies a missing-but-not-purged row as missing_asset")
  } else {
    fail(
      "precheck classifies a missing-but-not-purged row as missing_asset",
      missingPrecheck.action,
    )
  }

  const dnsCode = classifyCaptureError({
    url: "https://dead.example.invalid",
    err: new Error("getaddrinfo ENOTFOUND dead.example.invalid"),
  })
  if (dnsCode === "dns_failure" && classifyFailure(dnsCode) === "terminal") {
    pass("dead domain maps to dns_failure with no retry")
  } else {
    fail("dead domain maps to dns_failure with no retry", dnsCode)
  }

  const timeoutCode = classifyCaptureError({
    url: "http://127.0.0.1/slow",
    err: new Error("Navigation timeout of 1000 ms exceeded"),
  })
  if (timeoutCode === "nav_timeout" && classifyFailure(timeoutCode) === "retryable") {
    pass("slow route maps to nav_timeout with retries")
  } else {
    fail("slow route maps to nav_timeout with retries", timeoutCode)
  }

  const server = await startFixtureServer()

  try {
    await withTempStorageRoot(async () => {
      const captured = await captureRecording({
        url: `${server.baseUrl}/tall`,
        batchId: "fixture-batch",
        leadSlugValue: "tall-fixture",
        viewportWidth: 1280,
        viewportHeight: 720,
        navTimeoutMs: 30_000,
        scrollEaseMs: 800,
        postLoadDelayMs: 300,
        signal: AbortSignal.timeout(120_000),
      })

      if (
        captured.durationMs >= MIN_SCROLL_DURATION_MS &&
        captured.durationMs <= MAX_SCROLL_DURATION_MS
      ) {
        pass(
          "tall fixture produces mp4 in duration range",
          `${captured.durationMs}ms`,
        )
      } else {
        fail(
          "tall fixture produces mp4 in duration range",
          `${captured.durationMs}ms`,
        )
      }

      try {
        await captureRecording({
          url: `${server.baseUrl}/parked`,
          batchId: "fixture-batch",
          leadSlugValue: "parked-fixture",
          viewportWidth: 1280,
          viewportHeight: 720,
          navTimeoutMs: 10_000,
          scrollEaseMs: 800,
          postLoadDelayMs: 100,
          signal: AbortSignal.timeout(30_000),
        })
        fail("parked fixture fails capture", "expected CaptureFailedError")
      } catch (error) {
        if (error instanceof CaptureFailedError && error.code === "parked_domain") {
          pass("parked fixture fails with parked_domain")
        } else {
          fail(
            "parked fixture fails with parked_domain",
            error instanceof Error ? error.message : String(error),
          )
        }
      }

      try {
        await captureRecording({
          url: `${server.baseUrl}/slow`,
          batchId: "fixture-batch",
          leadSlugValue: "slow-fixture",
          viewportWidth: 1280,
          viewportHeight: 720,
          navTimeoutMs: 1_500,
          scrollEaseMs: 800,
          postLoadDelayMs: 100,
          signal: AbortSignal.timeout(30_000),
        })
        fail("slow fixture times out", "expected CaptureFailedError")
      } catch (error) {
        if (error instanceof CaptureFailedError && error.code === "nav_timeout") {
          pass("slow fixture times out with nav_timeout")
        } else {
          fail(
            "slow fixture times out with nav_timeout",
            error instanceof Error ? error.message : String(error),
          )
        }
      }
    })
  } finally {
    await server.close()
  }
}

async function runIntegrationLeg(): Promise<void> {
  console.log("\nverify:record — integration leg (Supabase)\n")

  const { createClient } = await import("@supabase/supabase-js")
  const { resetEnvCache } = await import("../lib/env")
  const { runRecordPrecheckGate } = await import(
    "../worker/steps/record-precheck-gate"
  )
  const { getLatestRecordingForPrecheck } = await import("../worker/db")

  resetEnvCache()
  const env = assertEnvOrExit()
  const supabase = createClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } },
  )

  const runId = Date.now().toString(36)
  let campaignId: string | null = null
  const leadIds: string[] = []

  try {
    const { data: campaign, error: campaignError } = await supabase
      .from("campaigns")
      .insert({
        name: `Verify Record ${runId}`,
        slug: `verify-record-${runId}`,
        description: "phase 16 gate fixture",
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
      fail("integration seed campaign", campaignError?.message ?? "no row")
      return
    }
    campaignId = campaign.id

    async function seedLead(slug: string): Promise<{
      leadId: string
      campaignLeadId: string
    }> {
      const { data: lead, error: leadError } = await supabase
        .from("leads")
        .insert({
          company: `Record verify ${slug}`,
          domain: `${slug}.example.com`,
        })
        .select("id")
        .single()
      if (leadError || !lead) {
        throw new Error(leadError?.message ?? "lead insert failed")
      }
      leadIds.push(lead.id)

      const { data: cl, error: clError } = await supabase
        .from("campaign_leads")
        .insert({
          campaign_id: campaignId!,
          lead_id: lead.id,
          slug,
          status: "queued",
          current_step: "recording",
        })
        .select("id")
        .single()
      if (clError || !cl) {
        throw new Error(clError?.message ?? "campaign_lead insert failed")
      }

      return { leadId: lead.id, campaignLeadId: cl.id }
    }

    const purgedLead = await seedLead(`purged-gate-${runId}`)
    const { data: purgedRecording, error: purgedRecError } = await supabase
      .from("recordings")
      .insert({
        lead_id: purgedLead.leadId,
        local_path: null,
        purged_at: new Date().toISOString(),
      })
      .select("id")
      .single()
    if (purgedRecError || !purgedRecording) {
      fail(
        "record step writes the purged re-record note event",
        purgedRecError?.message ?? "recording insert failed",
      )
      return
    }

    const loadedPurged = await getLatestRecordingForPrecheck(purgedLead.leadId)
    if (!loadedPurged?.purged_at) {
      fail(
        "record step writes the purged re-record note event",
        "getLatestRecordingForPrecheck did not return purged row",
      )
      return
    }

    const gateResult = await runRecordPrecheckGate({
      campaignLeadId: purgedLead.campaignLeadId,
      leadId: purgedLead.leadId,
      forcedRerecord: false,
    })

    const { data: noteEvents, error: noteError } = await supabase
      .from("pipeline_events")
      .select("message")
      .eq("campaign_lead_id", purgedLead.campaignLeadId)
      .eq("kind", "note")
      .eq("message", PURGED_RERECORD_NOTE)

    if (noteError) {
      fail(
        "record step writes the purged re-record note event",
        noteError.message,
      )
    } else if (gateResult === "capture" && (noteEvents?.length ?? 0) > 0) {
      pass("record step writes the purged re-record note event")
    } else {
      fail(
        "record step writes the purged re-record note event",
        `gate=${gateResult} notes=${noteEvents?.length ?? 0}`,
      )
    }

    const missingLead = await seedLead(`missing-gate-${runId}`)
    const missingRelPath = `verify-${runId}/missing-gate/recording.mp4`
    const { error: missingRecError } = await supabase.from("recordings").insert({
      lead_id: missingLead.leadId,
      local_path: missingRelPath,
      purged_at: null,
    })
    if (missingRecError) {
      fail(
        "record step fails missing-but-not-purged with missing_asset",
        missingRecError.message,
      )
      return
    }

    try {
      await runRecordPrecheckGate({
        campaignLeadId: missingLead.campaignLeadId,
        leadId: missingLead.leadId,
        forcedRerecord: false,
        statFile: async () => ({ exists: false }),
      })
      fail(
        "record step fails missing-but-not-purged with missing_asset",
        "expected PipelineStepError",
      )
    } catch (error) {
      if (error instanceof PipelineStepError && error.code === "missing_asset") {
        pass("record step fails missing-but-not-purged with missing_asset")
      } else {
        fail(
          "record step fails missing-but-not-purged with missing_asset",
          error instanceof Error ? error.message : String(error),
        )
      }
    }
  } catch (error) {
    fail("verify:record integration unexpected", (error as Error).message)
  } finally {
    for (const id of leadIds) {
      await supabase.from("leads").delete().eq("id", id)
    }
    if (campaignId) {
      await supabase.from("campaigns").delete().eq("id", campaignId)
    }
  }
}

const REAL_SITES = [
  "https://example.com",
  "https://www.wikipedia.org",
  "https://www.mozilla.org",
  "https://www.python.org",
  "https://www.gnu.org",
  "https://www.debian.org",
  "https://www.cloudflare.com",
  "https://www.nytimes.com",
  "https://www.bbc.com",
  "https://www.reddit.com",
] as const

async function runRealSiteLeg(): Promise<void> {
  console.log("\nReal-site leg (manual gate) — pinned list:")
  for (const site of REAL_SITES) {
    console.log(`  - ${site}`)
  }

  await withTempStorageRoot(async () => {
    for (const site of REAL_SITES) {
      try {
        const captured = await captureRecording({
          url: site,
          batchId: "real-verify",
          leadSlugValue: `real-${new URL(site).hostname.replace(/\./g, "-")}`,
          viewportWidth: 1920,
          viewportHeight: 1080,
          navTimeoutMs: 120_000,
          scrollEaseMs: 800,
          postLoadDelayMs: 1500,
          signal: AbortSignal.timeout(180_000),
        })

        if (
          captured.durationMs >= MIN_SCROLL_DURATION_MS &&
          captured.durationMs <= MAX_SCROLL_DURATION_MS
        ) {
          pass(`real site ${site}`, `${captured.durationMs}ms`)
        } else {
          fail(`real site ${site}`, `${captured.durationMs}ms out of range`)
        }
      } catch (error) {
        fail(
          `real site ${site}`,
          error instanceof Error ? error.message : String(error),
        )
      }
    }
  })
}

async function main(): Promise<void> {
  assertEnvOrExit()

  console.log("verify:record — fixture leg\n")
  await runFixtureLeg()
  await runIntegrationLeg()

  if (process.env.RECORD_REAL === "1") {
    console.log("\nverify:record — real-site leg\n")
    await runRealSiteLeg()
  } else {
    console.log("\nSkipping real-site leg (set RECORD_REAL=1 to enable).")
  }

  await closeSharedBrowser()

  const failed = results.filter((result) => !result.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)

  if (failed.length > 0) {
    process.exit(1)
  }
}

main().catch(async (error) => {
  console.error("verify:record fatal:", error)
  await closeSharedBrowser().catch(() => undefined)
  process.exit(1)
})
