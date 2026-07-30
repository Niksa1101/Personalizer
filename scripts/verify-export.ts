/**
 * Phase 15 export + promote verification — real Supabase, self-cleaning.
 */

import { execSync } from "node:child_process"
import path from "node:path"

import { createClient } from "@supabase/supabase-js"

import { canPromote } from "../lib/lead-actions"
import type { Database } from "../lib/database.types"
import {
  buildExportCsv,
  countExportRows,
  fetchExportRows,
  formatIsoSeconds,
} from "../lib/export"
import { assertEnvOrExit } from "../lib/env-node"
import { promoteLeads, unpromoteLead } from "../lib/leads"
import { SESSION_COOKIE_NAME } from "../lib/session"

interface CheckResult {
  name: string
  state: "pass" | "fail" | "skip"
  detail: string
}

const results: CheckResult[] = []
const BASE_URL = "http://127.0.0.1:3000"
const VALID_SHA1 = "0123456789abcdef0123456789abcdef01234567"

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

function getSetCookie(response: Response): string | null {
  const headers = response.headers as Headers & {
    getSetCookie?: () => string[]
  }
  if (typeof headers.getSetCookie === "function") {
    const values = headers.getSetCookie()
    return values.length > 0 ? values.join(", ") : null
  }
  return response.headers.get("set-cookie")
}

function parseCookies(setCookie: string | null): Map<string, string> {
  const jar = new Map<string, string>()
  if (!setCookie) return jar
  for (const part of setCookie.split(/,(?=\s*[^;]+=)/)) {
    const [pair] = part.split(";")
    const eq = pair?.indexOf("=")
    if (eq === undefined || eq <= 0) continue
    jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim())
  }
  return jar
}

async function loginSessionCookie(
  password: string,
): Promise<{ cookie: string } | { reason: string }> {
  let response: Response
  try {
    response = await fetch(`${BASE_URL}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    })
  } catch (error) {
    return {
      reason: error instanceof Error ? error.message : "login fetch failed",
    }
  }
  if (!response.ok) {
    return { reason: `login ${response.status}` }
  }
  const cookie = parseCookies(getSetCookie(response)).get(SESSION_COOKIE_NAME)
  if (!cookie) return { reason: "no session cookie" }
  return { cookie }
}

async function seedLead(
  supabase: ReturnType<typeof createClient<Database>>,
  campaignId: string,
  spec: {
    company: string
    status: Database["public"]["Enums"]["lead_status"]
    netlifyUrl?: string | null
    landingPageId?: string | null
    videoId?: string | null
    slug: string
    deployedDryRun?: boolean
  },
) {
  const { data: lead, error: leadError } = await supabase
    .from("leads")
    .insert({ company: spec.company, domain: `${spec.slug}.example.com` })
    .select("id")
    .single()
  if (leadError || !lead) throw new Error(leadError?.message ?? "lead insert")

  const { data: cl, error: clError } = await supabase
    .from("campaign_leads")
    .insert({
      campaign_id: campaignId,
      lead_id: lead.id,
      slug: spec.slug,
      status: spec.status,
      current_step: "deploy",
      netlify_url: spec.netlifyUrl ?? null,
      deployed_at: spec.netlifyUrl ? new Date().toISOString() : null,
      deployed_dry_run: spec.deployedDryRun ?? false,
      landing_page_id: spec.landingPageId ?? null,
      video_id: spec.videoId ?? null,
      promoted_at: spec.status === "ready" ? new Date().toISOString() : null,
    })
    .select("id")
    .single()
  if (clError || !cl) throw new Error(clError?.message ?? "campaign_lead insert")
  return { leadId: lead.id, campaignLeadId: cl.id }
}

async function main(): Promise<void> {
  const env = assertEnvOrExit()
  const supabase = createClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } },
  )

  const runId = Date.now().toString(36)
  let campaignId: string | null = null
  let archivedCampaignId: string | null = null
  const leadIds: string[] = []
  const fixtureIds: Record<string, string> = {}

  try {
    const { data: campaign, error: campaignError } = await supabase
      .from("campaigns")
      .insert({
        name: `Verify Export ${runId}`,
        slug: `verify-export-${runId}`,
        description: "phase 15 fixture",
        landing_template: "<html></html>",
        merge_layout: "bubble_br",
        pip_scale: 0.2,
        viewport_width: 1920,
        viewport_height: 1080,
        nav_timeout_ms: 120_000,
      })
      .select("id, ref")
      .single()
    if (campaignError || !campaign) {
      fail("seed campaign", campaignError?.message ?? "no row")
      return
    }
    campaignId = campaign.id

    const { data: archived, error: archivedError } = await supabase
      .from("campaigns")
      .insert({
        name: `Verify Export Archived ${runId}`,
        slug: `verify-export-arch-${runId}`,
        archived_at: new Date().toISOString(),
        landing_template: "<html></html>",
        merge_layout: "bubble_br",
        pip_scale: 0.2,
        viewport_width: 1920,
        viewport_height: 1080,
        nav_timeout_ms: 120_000,
      })
      .select("id")
      .single()
    if (archivedError || !archived) {
      fail("seed archived campaign", archivedError?.message ?? "no row")
      return
    }
    archivedCampaignId = archived.id

    const accent = await seedLead(supabase, campaignId!, {
      company: "Café Bränd",
      status: "ready",
      netlifyUrl: "https://example.com/accent",
      slug: `accent-${runId}`,
    })
    leadIds.push(accent.leadId)
    fixtureIds.accent = accent.campaignLeadId

    const formula = await seedLead(supabase, campaignId!, {
      company: "=SUM(A1)",
      status: "ready",
      netlifyUrl: "https://example.com/formula",
      slug: `formula-${runId}`,
    })
    leadIds.push(formula.leadId)
    fixtureIds.formula = formula.campaignLeadId

    const nullPage = await seedLead(supabase, campaignId!, {
      company: `Null page ${runId}`,
      status: "deployed",
      netlifyUrl: "https://example.com/null-page",
      landingPageId: null,
      slug: `null-page-${runId}`,
    })
    leadIds.push(nullPage.leadId)
    fixtureIds.nullPage = nullPage.campaignLeadId

    const nullVideo = await seedLead(supabase, campaignId!, {
      company: `Null video ${runId}`,
      status: "ready",
      netlifyUrl: "https://example.com/null-video",
      slug: `null-video-${runId}`,
    })
    leadIds.push(nullVideo.leadId)
    fixtureIds.nullVideo = nullVideo.campaignLeadId

    const removedReady = await seedLead(supabase, campaignId!, {
      company: `Removed page ${runId}`,
      status: "ready",
      netlifyUrl: "https://example.com/removed",
      slug: `removed-${runId}`,
    })
    leadIds.push(removedReady.leadId)
    fixtureIds.removed = removedReady.campaignLeadId
    const { data: removedPage } = await supabase
      .from("landing_pages")
      .insert({
        campaign_lead_id: removedReady.campaignLeadId,
        path: `/verify-removed-${runId}`,
        deploy_status: "removed",
        html: "<html></html>",
        content_sha1: VALID_SHA1,
      })
      .select("id")
      .single()
    await supabase
      .from("campaign_leads")
      .update({ landing_page_id: removedPage!.id })
      .eq("id", removedReady.campaignLeadId)

    const promotable = await seedLead(supabase, campaignId!, {
      company: `Promotable ${runId}`,
      status: "deployed",
      netlifyUrl: "https://example.com/promote",
      slug: `promote-${runId}`,
    })
    leadIds.push(promotable.leadId)
    fixtureIds.promotable = promotable.campaignLeadId

    const dryRunNoUrl = await seedLead(supabase, campaignId!, {
      company: `Dry run no url ${runId}`,
      status: "deployed",
      netlifyUrl: null,
      slug: `dry-${runId}`,
      deployedDryRun: true,
    })
    leadIds.push(dryRunNoUrl.leadId)
    fixtureIds.dryRunNoUrl = dryRunNoUrl.campaignLeadId

    const unpubDeployed = await seedLead(supabase, campaignId!, {
      company: `Unpub deployed ${runId}`,
      status: "deployed",
      netlifyUrl: "https://example.com/unpub-deployed",
      slug: `unpub-dep-${runId}`,
    })
    leadIds.push(unpubDeployed.leadId)
    fixtureIds.unpubDeployed = unpubDeployed.campaignLeadId
    const { data: unpubPageSeed } = await supabase
      .from("landing_pages")
      .insert({
        campaign_lead_id: unpubDeployed.campaignLeadId,
        path: `/verify-unpub-dep-${runId}`,
        deploy_status: "removed",
        html: "<html></html>",
        content_sha1: VALID_SHA1,
      })
      .select("id")
      .single()
    await supabase
      .from("campaign_leads")
      .update({ landing_page_id: unpubPageSeed!.id })
      .eq("id", unpubDeployed.campaignLeadId)

    pass("seed fixtures")

    const { data: nullPageView } = await supabase
      .from("v_exportable_leads")
      .select("is_page_removed")
      .eq("id", fixtureIds.nullPage!)
      .single()
    if (nullPageView?.is_page_removed !== false) {
      fail("view COALESCE null landing_page_id", `got ${nullPageView?.is_page_removed}`)
    } else {
      pass("view COALESCE null landing_page_id")
    }

    const exportNullPage = await fetchExportRows({
      campaignId: campaignId!,
      statuses: ["deployed"],
    })
    if (!exportNullPage.rows.some((r) => r.id === fixtureIds.nullPage)) {
      fail("null-page lead appears in export", "missing from fetchExportRows")
    } else {
      pass("null-page lead appears in export")
    }

    const promoteOutcomes = await promoteLeads([fixtureIds.promotable!], "bulk")
    const skippedPromote = promoteOutcomes.filter((o) => o.outcome === "skipped")
    if (skippedPromote.length > 0) {
      fail("promote happy path zero skipped", JSON.stringify(skippedPromote))
    } else {
      pass("promote happy path zero skipped")
    }

    const { data: promotedRow } = await supabase
      .from("campaign_leads")
      .select("status, promoted_at")
      .eq("id", fixtureIds.promotable!)
      .single()
    if (promotedRow?.status !== "ready" || !promotedRow.promoted_at) {
      fail("promote sets ready + promoted_at", JSON.stringify(promotedRow))
    } else {
      pass("promote sets ready + promoted_at")
    }

    const { data: promotedEvent } = await supabase
      .from("pipeline_events")
      .select("kind, step")
      .eq("campaign_lead_id", fixtureIds.promotable!)
      .eq("kind", "promoted")
      .order("id", { ascending: true })
      .limit(1)
      .maybeSingle()
    if (promotedEvent?.kind !== "promoted" || promotedEvent.step != null) {
      fail("promoted event step IS NULL", JSON.stringify(promotedEvent))
    } else {
      pass("promoted event step IS NULL")
    }

    const skipTargets: Array<{ reason: string; id: string }> = [
      { reason: "not_deployed", id: fixtureIds.accent! },
      { reason: "no_live_url", id: fixtureIds.dryRunNoUrl! },
      { reason: "page_unpublished", id: fixtureIds.unpubDeployed! },
      { reason: "not_found", id: "00000000-0000-4000-8000-000000000001" },
    ]

    await supabase
      .from("campaign_leads")
      .update({
        status: "deployed",
        promoted_at: null,
        netlify_url: "https://example.com/removed-deployed",
      })
      .eq("id", fixtureIds.removed!)

    for (const target of skipTargets) {
      const outcomes = await promoteLeads([target.id], "bulk")
      const row = outcomes[0]
      if (!row || row.outcome !== "skipped" || row.reason !== target.reason) {
        fail(`promote skip ${target.reason}`, JSON.stringify(row))
      } else {
        pass(`promote skip ${target.reason}`)
      }
    }

    await supabase
      .from("campaign_leads")
      .update({ status: "ready", promoted_at: new Date().toISOString() })
      .eq("id", fixtureIds.removed!)

    const firstPromotedAt = promotedRow!.promoted_at!
    await new Promise((r) => setTimeout(r, 50))
    await supabase
      .from("campaign_leads")
      .update({
        status: "deployed",
        promoted_at: null,
        netlify_url: "https://example.com/promote",
      })
      .eq("id", fixtureIds.promotable!)
    const rePromote = await promoteLeads([fixtureIds.promotable!], "bulk")
    if (rePromote[0]?.outcome !== "success") {
      fail("re-promote", JSON.stringify(rePromote))
    } else {
      const { data: second } = await supabase
        .from("campaign_leads")
        .select("promoted_at")
        .eq("id", fixtureIds.promotable!)
        .single()
      if (!second?.promoted_at || second.promoted_at === firstPromotedAt) {
        fail("re-promote overwrites promoted_at", `${firstPromotedAt} -> ${second?.promoted_at}`)
      } else {
        pass("re-promote overwrites promoted_at")
      }
    }

    const { count: promotedEvents } = await supabase
      .from("pipeline_events")
      .select("*", { count: "exact", head: true })
      .eq("campaign_lead_id", fixtureIds.promotable!)
      .eq("kind", "promoted")
    if ((promotedEvents ?? 0) < 2) {
      fail("re-promote writes a second promoted event", `got ${promotedEvents}`)
    } else {
      pass("re-promote writes a second promoted event")
    }

    await unpromoteLead(fixtureIds.promotable!)
    const { data: unpromoted } = await supabase
      .from("campaign_leads")
      .select("status, promoted_at")
      .eq("id", fixtureIds.promotable!)
      .single()
    if (unpromoted?.status !== "deployed" || unpromoted.promoted_at != null) {
      fail("unpromote", JSON.stringify(unpromoted))
    } else {
      pass("unpromote clears promoted_at")
    }

    const { data: noteEvent } = await supabase
      .from("pipeline_events")
      .select("kind")
      .eq("campaign_lead_id", fixtureIds.promotable!)
      .eq("kind", "note")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle()
    if (noteEvent?.kind !== "note") fail("unpromote note event", "missing")
    else pass("unpromote note event")

    const empty = await promoteLeads([], "bulk")
    if (empty.length !== 0) fail("empty promote array", `got ${empty.length} rows`)
    else pass("empty promote array")

    try {
      await promoteLeads(Array.from({ length: 201 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`), "bulk")
      fail("promote cap 201", "expected exception")
    } catch (error) {
      if (error instanceof Error && error.message.includes("200 cap")) {
        pass("promote cap 201")
      } else {
        fail("promote cap 201", (error as Error).message)
      }
    }

    const { data: removedView } = await supabase
      .from("v_exportable_leads")
      .select("is_page_removed, status")
      .eq("id", fixtureIds.removed!)
      .single()

    const { data: removedPageRow } = await supabase
      .from("landing_pages")
      .select("deploy_status")
      .eq("id", removedPage!.id)
      .single()

    const canPromoteRemoved = canPromote({
      status: removedView?.status ?? "ready",
      netlifyUrl: "https://example.com/removed",
      pageDeployStatus: removedPageRow?.deploy_status ?? null,
    })

    const removedInExport = await fetchExportRows({
      campaignId: campaignId!,
      statuses: ["ready"],
    })

    const seamOk =
      removedView?.is_page_removed === true &&
      !canPromoteRemoved.ok &&
      !removedInExport.rows.some((r) => r.id === fixtureIds.removed)
    if (!seamOk) fail("canPromote/export seam removed page", "mismatch")
    else pass("canPromote/export seam removed page")

    const csv = buildExportCsv(
      (await fetchExportRows({ campaignId: campaignId!, statuses: ["ready"] })).rows,
    )

    if (!csv.includes('"Café Bränd"')) fail("CSV accents", "exact accented cell missing")
    else pass("CSV accents")

    if (!csv.includes(`"'=SUM(A1)"`)) fail("CSV formula injection", `expected "'=SUM(A1)"`)
    else pass("CSV formula injection")

    if (/(?<!\r)\n/.test(csv)) fail("CSV CRLF only", "lone LF found")
    else pass("CSV CRLF only")

    if (!csv.endsWith("\r\n")) fail("CSV final record terminated", "no trailing CRLF")
    else pass("CSV final record terminated")

    const ts = formatIsoSeconds("2026-07-29T14:03:21.123456+00:00")
    if (!ts || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(ts)) {
      fail("timestamp format", ts ?? "null")
    } else {
      pass("timestamp format")
    }

    const archivedLead = await seedLead(supabase, archivedCampaignId!, {
      company: `Archived ${runId}`,
      status: "ready",
      netlifyUrl: "https://example.com/archived",
      slug: `arch-${runId}`,
    })
    leadIds.push(archivedLead.leadId)

    const namedArchived = await countExportRows({
      campaignId: archivedCampaignId!,
      statuses: ["ready"],
    })
    if (namedArchived.exportable < 1) {
      fail("named archived campaign exports", String(namedArchived.exportable))
    } else {
      pass("named archived campaign exports")
    }

    const omittedArchived = await countExportRows({ statuses: ["ready"] })
    const allReady = await fetchExportRows({ statuses: ["ready"] })
    if (allReady.rows.length !== omittedArchived.exportable) {
      fail(
        "count matches fetched rows",
        `${omittedArchived.exportable} counted vs ${allReady.rows.length} fetched`,
      )
    } else {
      pass("count matches fetched rows")
    }
    const hasArchivedInAll = allReady.rows.some(
      (r) => r.id === archivedLead.campaignLeadId,
    )
    if (hasArchivedInAll) {
      fail("omitted campaign excludes archived", "archived row present")
    } else {
      pass("omitted campaign excludes archived")
    }

    const login = await loginSessionCookie(env.APP_PASSWORD)
    const removedFixtureCompany = `Removed page ${runId}`

    if ("reason" in login) {
      skip("GET /api/export BOM", login.reason)
      skip("GET /api/export exclusion header", login.reason)
      skip("GET /api/export body excludes removed", login.reason)
      skip("X-Export-Missing-Video counts the null-video fixture", login.reason)
      skip("X-Export-Row-Count matches the CSV record count", login.reason)
    } else {
      try {
        const res = await fetch(
          `${BASE_URL}/api/export?campaign=${campaignId}&status=ready`,
          {
            headers: { Cookie: `${SESSION_COOKIE_NAME}=${login.cookie}` },
            signal: AbortSignal.timeout(15_000),
          },
        )
        if (!res.ok) {
          fail("GET /api/export", String(res.status))
        } else {
          const buf = Buffer.from(await res.arrayBuffer())
          if (buf[0] !== 0xef || buf[1] !== 0xbb || buf[2] !== 0xbf) {
            fail("GET /api/export BOM", `bytes ${buf.slice(0, 3).toString("hex")}`)
          } else {
            pass("GET /api/export BOM")
          }
          const skipped = Number(res.headers.get("X-Export-Skipped") ?? "-1")
          if (skipped < 1) {
            fail("GET /api/export exclusion header", `X-Export-Skipped=${skipped}`)
          } else {
            pass("GET /api/export exclusion header", String(skipped))
          }
          const body = buf.slice(3).toString("utf8")
          if (body.includes(removedFixtureCompany)) {
            fail(
              "GET /api/export body excludes removed",
              "removed fixture company in body",
            )
          } else {
            pass("GET /api/export body excludes removed")
          }

          const missing = Number(res.headers.get("X-Export-Missing-Video") ?? "-1")
          if (missing < 1) {
            fail(
              "X-Export-Missing-Video counts the null-video fixture",
              `got ${missing}`,
            )
          } else {
            pass("X-Export-Missing-Video counts the null-video fixture")
          }

          const rowCount = Number(res.headers.get("X-Export-Row-Count") ?? "-1")
          const records = body.trimEnd().split("\r\n").length - 1
          if (rowCount !== records) {
            fail(
              "X-Export-Row-Count matches the CSV record count",
              `${rowCount} vs ${records}`,
            )
          } else {
            pass("X-Export-Row-Count matches the CSV record count")
          }
        }
      } catch (error) {
        skip(
          "GET /api/export BOM",
          error instanceof Error ? error.message : "fetch failed",
        )
        skip("GET /api/export exclusion header", "dev server unreachable")
        skip("GET /api/export body excludes removed", "dev server unreachable")
        skip(
          "X-Export-Missing-Video counts the null-video fixture",
          "dev server unreachable",
        )
        skip(
          "X-Export-Row-Count matches the CSV record count",
          "dev server unreachable",
        )
      }
    }

    const { data: realReady } = await supabase
      .from("v_exportable_leads")
      .select("landing_url")
      .eq("status", "ready")
      .eq("is_page_removed", false)
      .not("landing_url", "is", null)
      .not("landing_url", "like", "%example.com%")
      .limit(5)

    if (!realReady || realReady.length === 0) {
      skip("AC-2 URL leg", "no non-example.com ready rows")
    } else {
      const args: string[] = []
      for (const row of realReady.slice(0, 3)) {
        if (row.landing_url) args.push(row.landing_url, "200")
      }
      try {
        execSync(
          `npx tsx scripts/check-urls.ts ${args.map((a) => JSON.stringify(a)).join(" ")}`,
          {
            cwd: path.resolve(import.meta.dirname, ".."),
            stdio: "pipe",
            env: process.env,
            timeout: 90_000,
          },
        )
        pass("AC-2 URL leg", `${Math.min(realReady.length, 3)} URL(s)`)
      } catch (error) {
        const output =
          error && typeof error === "object" && "stdout" in error
            ? String((error as { stdout?: Buffer }).stdout ?? "")
            : String(error)
        fail("AC-2 URL leg", output.slice(0, 300))
      }
    }
  } catch (error) {
    fail("verify:export unexpected", (error as Error).message)
  } finally {
    if (campaignId) await supabase.from("campaigns").delete().eq("id", campaignId)
    if (archivedCampaignId) {
      await supabase.from("campaigns").delete().eq("id", archivedCampaignId)
    }
    for (const id of leadIds) {
      await supabase.from("leads").delete().eq("id", id)
    }

    let retainedTotal = 0
    for (const pattern of [`%verify-removed-${runId}%`, `%verify-unpub-dep-${runId}%`]) {
      const { count } = await supabase
        .from("retained_pages")
        .select("*", { count: "exact", head: true })
        .like("path", pattern)
      retainedTotal += count ?? 0
    }
    if (retainedTotal > 0) fail("teardown retained_pages", String(retainedTotal))
    else pass("teardown retained_pages")

    if (campaignId) {
      const { data: strayPending } = await supabase
        .from("pending_site_sync")
        .select("meta")
      const hasFixture = (strayPending ?? []).some((row) => {
        const meta = row.meta as { campaign_lead_id?: string } | null
        return Object.values(fixtureIds).includes(meta?.campaign_lead_id ?? "")
      })
      if (hasFixture) fail("teardown pending_site_sync", "fixture residue")
      else pass("teardown pending_site_sync")
    }
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
