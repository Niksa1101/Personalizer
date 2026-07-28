/**
 * Phase 13 leads verification — real Supabase, self-cleaning.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"

import { createClient } from "@supabase/supabase-js"

import { buildRetryPatch } from "../lib/lead-actions"
import type { Database } from "../lib/database.types"
import { ERROR_CODES, DRAWER_ACTION_IDS, ERROR_COPY } from "../lib/error-copy"
import { LEAD_SORT_COLUMNS, parseLeadFilters } from "../lib/lead-filters"
import {
  deriveRequeueModeForLead,
  LeadMutationError,
  listLeads,
  requeueLead,
  updateLead,
} from "../lib/leads"
import { subscribeLeadsStream } from "../lib/leads-stream"
import { retryCampaignLead } from "../lib/pipeline-control"
import { assertEnvOrExit } from "../lib/env-node"
import { closeQueueConnections } from "../lib/queue"
import { pendingJobIds, removeJobsThisRunOrphaned } from "./queue-sweep"
import { getSupabaseAdmin } from "../lib/supabase"
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

async function probeServer(): Promise<boolean> {
  try {
    const response = await fetch(`${BASE_URL}/login`, {
      redirect: "manual",
      signal: AbortSignal.timeout(3000),
    })
    return response.status >= 200 && response.status < 500
  } catch {
    return false
  }
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
    })
  } catch (error) {
    return { reason: `POST /api/login threw: ${(error as Error).message}` }
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "")
    return {
      reason: `POST /api/login returned ${response.status}${
        body ? ` — ${body.slice(0, 120)}` : ""
      }`,
    }
  }

  const cookie = parseCookies(getSetCookie(response)).get(SESSION_COOKIE_NAME)
  if (!cookie) {
    return {
      reason: `login 200 but no ${SESSION_COOKIE_NAME} cookie in Set-Cookie`,
    }
  }
  return { cookie }
}

function parseSseEvents(buffer: string): {
  events: Array<{ event: string; data: string }>
  remainder: string
} {
  const events: Array<{ event: string; data: string }> = []
  const parts = buffer.split("\n\n")
  const remainder = parts.pop() ?? ""

  for (const part of parts) {
    if (!part.trim() || part.startsWith(":")) continue

    let event = "message"
    const dataLines: string[] = []

    for (const line of part.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim()
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim())
    }

    if (dataLines.length > 0) {
      events.push({ event, data: dataLines.join("\n") })
    }
  }

  return { events, remainder }
}

const CHANNEL_JOIN_MS = 8_000
const CHANNEL_PUSH_MS = 10_000

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await sleep(100)
  }
  return predicate()
}

/** Reads join off the channel itself, not off the first delivered payload —
 *  that payload is the SUBSCRIBED resync, so inferring join from it would make
 *  every leg below report "never joined" the moment the resync regressed. */
function leadsChannelJoined(): boolean {
  const state = (
    globalThis as unknown as Record<symbol, { channel?: { state?: string } | null }>
  )[Symbol.for("personalizer.leadsStream")]
  return state?.channel?.state === "joined"
}

/**
 * The stack overflow of Phase 13 finding 13 lived *here* — `lib/leads-stream.ts`
 * — and was found by hand, not by this script. The same defect in
 * `lib/dashboard-stream.ts` (finding 14) then sat latent through an 18/18
 * `verify:dashboard` run for exactly one reason: neither script ever forced a
 * channel error, so both streams were only ever exercised healthy.
 *
 * These legs mirror the ones in `verify-dashboard.ts` so the two streams cannot
 * drift back into that asymmetry. In-process by necessity: the module is a
 * module-scope singleton, and over HTTP the host swallows the RangeError while
 * `state.channel` still lands on null, leaving every observable check green.
 */
async function checkLeadsChannelLifecycle(
  supabase: ReturnType<typeof createClient<Database>>,
  pokeLeadId: string,
): Promise<void> {
  // The recursion re-enters through the promise supabase-js returns, so nothing
  // is on the stack to catch — it surfaces as unhandled rejections instead.
  const rangeErrors: string[] = []
  const onRejection = (reason: unknown) => {
    if (reason instanceof RangeError) rangeErrors.push(reason.message)
  }
  process.on("unhandledRejection", onRejection)

  const poke = () =>
    supabase
      .from("campaign_leads")
      .update({ updated_at: new Date().toISOString() })
      .eq("id", pokeLeadId)

  try {
    const first = new AbortController()
    let changed = 0
    let resyncs = 0
    const unsubscribeFirst = subscribeLeadsStream({
      scope: { campaignId: null, includeArchived: false },
      enqueueChanged: () => {
        changed += 1
      },
      enqueueEvent: () => undefined,
      enqueueResync: () => {
        resyncs += 1
      },
      onError: () => undefined,
      signal: first.signal,
    })

    if (!(await waitFor(leadsChannelJoined, CHANNEL_JOIN_MS))) {
      fail("leads channel emits resync on join", "channel never joined")
      fail("leads channel resyncs after a socket kill", "channel never joined")
      fail("leads channel teardown does not recurse", "channel never joined")
      fail("leads channel rebuilt after teardown", "channel never joined")
      unsubscribeFirst()
      first.abort()
      return
    }

    // Realtime is not a replay log: rows that changed while the channel was
    // still joining are never delivered, so the resync on SUBSCRIBED is the
    // only thing standing between a fresh subscriber and stale rows.
    if (await waitFor(() => resyncs > 0, CHANNEL_PUSH_MS)) {
      pass("leads channel emits resync on join")
    } else {
      fail(
        "leads channel emits resync on join",
        `no resync within ${CHANNEL_PUSH_MS}ms of joining`,
      )
    }

    // Unlike the dashboard stream, this one has **no** periodic safety net — no
    // RESNAPSHOT_MS equivalent. So the resync on rejoin is the only thing that
    // repairs rows missed while the socket was down; without it a client sits on
    // stale rows until it navigates.
    const resyncsBeforeKill = resyncs
    getSupabaseAdmin().realtime.disconnect()
    await poke()

    if (await waitFor(() => resyncs > resyncsBeforeKill, 20_000)) {
      pass("leads channel resyncs after a socket kill")
    } else {
      fail(
        "leads channel resyncs after a socket kill",
        "socket died and no resync followed the rejoin — rows missed in the gap are never repaired",
      )
    }

    rangeErrors.length = 0
    unsubscribeFirst()
    first.abort()
    // The re-entrant CLOSED dispatch lands a few microtask turns later.
    await sleep(1_000)

    if (rangeErrors.length > 0) {
      fail(
        "leads channel teardown does not recurse",
        `${rangeErrors.length} unhandled RangeError(s) — ${rangeErrors[0]}`,
      )
    } else {
      pass("leads channel teardown does not recurse")
    }

    const second = new AbortController()
    let rechanged = 0
    const unsubscribeSecond = subscribeLeadsStream({
      scope: { campaignId: null, includeArchived: false },
      enqueueChanged: () => {
        rechanged += 1
      },
      enqueueEvent: () => undefined,
      enqueueResync: () => undefined,
      onError: () => undefined,
      signal: second.signal,
    })

    if (!(await waitFor(leadsChannelJoined, CHANNEL_JOIN_MS))) {
      fail("leads channel rebuilt after teardown", "channel never rejoined")
    } else {
      const before = rechanged
      await poke()
      if (await waitFor(() => rechanged > before, CHANNEL_PUSH_MS)) {
        pass("leads channel rebuilt after teardown")
      } else {
        // The pre-fix state: `state.channel` never cleared, so ensureChannel()
        // short-circuits forever and no UPDATE is forwarded again for the life
        // of the process. There is no resnapshot safety net on this stream.
        fail(
          "leads channel rebuilt after teardown",
          `no UPDATE forwarded within ${CHANNEL_PUSH_MS}ms`,
        )
      }
    }

    unsubscribeSecond()
    second.abort()
    await sleep(500)
    void changed
  } finally {
    process.off("unhandledRejection", onRejection)
  }
}

async function main(): Promise<void> {
  const env = assertEnvOrExit()
  const supabase = createClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } },
  )
  const pendingJobIdsAtStart = await pendingJobIds()

  const runId = Date.now().toString(36)
  const mediaDirAbs = path.join(env.LOCAL_STORAGE_ROOT, "verify", runId)
  const mediaAbsPath = path.join(mediaDirAbs, "media.mp4")
  let campaignId: string | null = null
  let otherCampaignId: string | null = null
  const leadIds: string[] = []
  const retainedPagePaths: string[] = []
  // pending_site_sync has no FK to campaign_leads, so deleting the throwaway
  // campaign does not take these with it. Left behind they queue a real site
  // sync, so every RPC that writes a marker records its lead id here.
  const siteSyncLeadIds: string[] = []
  let worstPerfMs = 0

  try {
    for (const code of ERROR_CODES) {
      if (!ERROR_COPY[code]) fail("error-copy exhaustiveness", `missing ${code}`)
    }
    for (const code of ERROR_CODES) {
      if (!DRAWER_ACTION_IDS.includes(ERROR_COPY[code].action.id as never)) {
        fail("DRAWER_ACTION_IDS", `${code} action missing`)
      }
    }
    pass("error-copy exhaustiveness")

    const deployPatch = buildRetryPatch("step", "deploy")
    if (
      deployPatch.netlify_url !== null ||
      deployPatch.deployed_at !== null ||
      deployPatch.deployed_dry_run !== false
    ) {
      fail("buildRetryPatch deploy", "deploy reset keys incorrect")
    }
    pass("buildRetryPatch deploy single object")

    const { data: campaign, error: campaignError } = await supabase
      .from("campaigns")
      .insert({
        name: `Verify Leads ${runId}`,
        slug: `verify-leads-${runId}`,
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
      fail("seed campaign", campaignError?.message ?? "insert failed")
    }
    campaignId = campaign!.id

    const { data: otherCampaign, error: otherCampaignError } = await supabase
      .from("campaigns")
      .insert({
        name: `Verify Leads Other ${runId}`,
        slug: `verify-leads-other-${runId}`,
        landing_template: "<html></html>",
        merge_layout: "bubble_br",
        pip_scale: 0.2,
        viewport_width: 1920,
        viewport_height: 1080,
        nav_timeout_ms: 120_000,
      })
      .select("id")
      .single()

    if (otherCampaignError || !otherCampaign) {
      fail("seed other campaign", otherCampaignError?.message ?? "insert failed")
    }
    otherCampaignId = otherCampaign!.id

    for (const spec of [
      { company: `Verify 50% Off ${runId}`, domain: `verify-50-${runId}.example.com` },
      { company: `Verify a_b Co ${runId}`, domain: `verify-ab-${runId}.example.com` },
      {
        company: `Verify Acme, Inc ${runId}`,
        domain: `verify-acme-${runId}.example.com`,
      },
    ]) {
      const { data: lead, error: leadError } = await supabase
        .from("leads")
        .insert(spec)
        .select("id")
        .single()
      if (leadError || !lead) {
        fail("seed search leads", leadError?.message ?? spec.company)
      } else {
        leadIds.push(lead.id)
        await supabase.from("campaign_leads").insert({
          campaign_id: campaignId,
          lead_id: lead.id,
          slug: `verify-search-${lead.id.slice(0, 8)}`,
          status: "queued",
          current_step: "recording",
          queued_at: new Date().toISOString(),
        })
      }
    }

    const inserts: Database["public"]["Tables"]["campaign_leads"]["Insert"][] =
      []
    for (let i = 0; i < 500; i++) {
      const { data: lead, error: leadError } = await supabase
        .from("leads")
        .insert({
          company: `Verify Leads Co ${i} ${runId}`,
          domain: `verify-leads-${runId}-${i}.example.com`,
        })
        .select("id")
        .single()
      if (leadError || !lead) fail("seed 500 leads", leadError?.message ?? `lead ${i}`)
      leadIds.push(lead!.id)
      inserts.push({
        campaign_id: campaignId,
        lead_id: lead!.id,
        slug: `verify-lead-${i}`,
        status: i % 7 === 0 ? "failed" : "queued",
        current_step: "recording",
        queued_at: new Date().toISOString(),
        ...(i % 7 === 0
          ? { error_code: "nav_timeout" as const, error_detail: "verify seed" }
          : {}),
      })
    }

    const { error: bulkError } = await supabase
      .from("campaign_leads")
      .insert(inserts)
    if (bulkError) fail("seed 500 campaign_leads", bulkError.message)
    pass("seed 500 leads")

    for (const sort of LEAD_SORT_COLUMNS) {
      const t0 = performance.now()
      const listed = await listLeads(
        parseLeadFilters({ campaign: campaignId!, page: "1", sort, order: "desc" }),
      )
      worstPerfMs = Math.max(worstPerfMs, Math.round(performance.now() - t0))
      if (listed.rows.length === 0) fail(`listLeads sort=${sort}`, "no rows")
    }

    {
      const t0 = performance.now()
      await listLeads(
        parseLeadFilters({
          campaign: campaignId!,
          page: "1",
          q: `Verify Leads Co 1 ${runId}`,
          sort: "company",
          order: "asc",
        }),
      )
      worstPerfMs = Math.max(worstPerfMs, Math.round(performance.now() - t0))
    }
    pass("filter + sort + paginate", `worst ${worstPerfMs} ms`)

    const percentSearch = await listLeads(
      parseLeadFilters({ campaign: campaignId!, q: "50%" }),
    )
    if (
      !percentSearch.rows.some((row) =>
        row.leads.company?.includes("Verify 50% Off"),
      )
    ) {
      fail("search literal percent", "expected Verify 50% Off row")
    } else pass("search literal percent")

    const wildcardLeak = await listLeads(
      parseLeadFilters({ campaign: campaignId!, q: "Acme%Inc" }),
    )
    if (wildcardLeak.rows.length !== 0) {
      fail("search percent wildcard leak", `got ${wildcardLeak.rows.length} rows`)
    } else pass("search percent wildcard leak")

    const commaSearch = await listLeads(
      parseLeadFilters({ campaign: campaignId!, q: "Acme, Inc" }),
    )
    if (
      !commaSearch.rows.some((row) =>
        row.leads.company?.includes("Verify Acme, Inc"),
      )
    ) {
      fail("search comma company", "expected Acme, Inc row")
    } else pass("search comma company")

    const { data: deployedLead, error: deployedLeadError } = await supabase
      .from("campaign_leads")
      .select("id")
      .eq("campaign_id", campaignId)
      .limit(1)
      .single()

    if (deployedLeadError || !deployedLead) {
      fail("23514 setup", deployedLeadError?.message ?? "no lead")
    }

    await supabase
      .from("campaign_leads")
      .update({
        status: "deployed",
        current_step: "deploy",
        netlify_url: "https://example.com/verify",
        deployed_at: new Date().toISOString(),
        deployed_dry_run: false,
      })
      .eq("id", deployedLead!.id)

    const { data: page } = await supabase
      .from("landing_pages")
      .insert({
        campaign_lead_id: deployedLead!.id,
        path: `/verify-leads-${runId}/page`,
        deploy_status: "live",
        html: "<html>verify</html>",
        content_sha1: VALID_SHA1,
      })
      .select("id")
      .single()

    if (page) {
      await supabase
        .from("campaign_leads")
        .update({ landing_page_id: page.id })
        .eq("id", deployedLead!.id)
    }

    try {
      await retryCampaignLead(deployedLead!.id, "step", "deploy")
      pass("23514 deploy-step retry")
    } catch (error) {
      fail(
        "23514 deploy-step retry",
        error instanceof Error ? error.message : String(error),
      )
    }

    const { data: afterRetry } = await supabase
      .from("campaign_leads")
      .select("status, netlify_url, deployed_at, deployed_dry_run")
      .eq("id", deployedLead!.id)
      .single()

    if (
      afterRetry?.status !== "queued" ||
      afterRetry.netlify_url != null ||
      afterRetry.deployed_at != null ||
      afterRetry.deployed_dry_run !== false
    ) {
      fail("23514 column state", JSON.stringify(afterRetry))
    } else pass("23514 column state")

    const { data: editableLead, error: editableLeadError } = await supabase
      .from("leads")
      .insert({
        company: `Verify Edit ${runId}`,
        domain: `verify-edit-${runId}.example.com`,
        website_url: "https://verify-edit.example.com",
      })
      .select("id, updated_at")
      .single()

    if (editableLeadError || !editableLead) {
      fail("updateLead setup", editableLeadError?.message ?? "lead insert failed")
    } else {
      leadIds.push(editableLead.id)
      const { data: editableCl, error: editableClError } = await supabase
        .from("campaign_leads")
        .insert({
          campaign_id: campaignId,
          lead_id: editableLead.id,
          slug: `verify-edit-${runId}`,
          status: "failed",
          error_code: "nav_timeout",
          error_detail: "verify edit seed",
          current_step: "recording",
        })
        .select("id")
        .single()

      if (editableClError || !editableCl) {
        fail("updateLead setup", editableClError?.message ?? "cl insert failed")
      } else {
        await supabase.from("recordings").insert({
          lead_id: editableLead.id,
          local_path: `verify/${runId}/edit-recording.mp4`,
        })
        const { data: recording } = await supabase
          .from("recordings")
          .select("id")
          .eq("lead_id", editableLead.id)
          .single()
        if (recording) {
          await supabase
            .from("campaign_leads")
            .update({ recording_id: recording.id })
            .eq("id", editableCl.id)
        }

        try {
          await updateLead(editableCl.id, {
            first_name: null,
            last_name: null,
            full_name: null,
            company: `Verify Edit ${runId}`,
            email: null,
            phone: null,
            website_url: "",
            city: null,
            state: null,
            country: null,
            merge_layout: null,
            pip_scale: null,
            leads_updated_at: editableLead.updated_at,
          })
          fail("updateLead clear website", "expected identifiable field error")
        } catch (error) {
          if (
            error instanceof LeadMutationError &&
            error.field === "website_url"
          ) {
            pass("updateLead clear website")
          } else {
            fail(
              "updateLead clear website",
              error instanceof Error ? error.message : String(error),
            )
          }
        }

        const { data: refreshedLead } = await supabase
          .from("leads")
          .select("updated_at")
          .eq("id", editableLead.id)
          .single()

        if (!refreshedLead) {
          fail("updateLead url change", "lead missing")
        } else {
          try {
            const result = await updateLead(editableCl.id, {
              first_name: null,
              last_name: null,
              full_name: null,
              company: `Verify Edit ${runId}`,
              email: null,
              phone: null,
              website_url: "https://changed-verify.example.com",
              city: null,
              state: null,
              country: null,
              merge_layout: null,
              pip_scale: null,
              leads_updated_at: refreshedLead.updated_at,
            })
            if (!result.websiteUrlChanged) {
              fail("updateLead url change", "websiteUrlChanged=false")
            } else {
              const { data: domainRow } = await supabase
                .from("leads")
                .select("domain")
                .eq("id", editableLead.id)
                .single()
              const { data: purgedRecording } = await supabase
                .from("recordings")
                .select("purged_at, local_path")
                .eq("lead_id", editableLead.id)
                .single()
              if (
                domainRow?.domain === "changed-verify.example.com" &&
                purgedRecording?.purged_at &&
                purgedRecording.local_path == null
              ) {
                pass("updateLead url change")
              } else {
                fail(
                  "updateLead url change",
                  `domain=${domainRow?.domain} purged=${!!purgedRecording?.purged_at}`,
                )
              }
            }
          } catch (error) {
            fail(
              "updateLead url change",
              error instanceof Error ? error.message : String(error),
            )
          }
        }
      }
    }

    // The URL-change note must only count until the lead is next queued.
    // Unbounded it matches forever, so a later name-only edit would still
    // derive `restart` and silently re-record a lead that never changed.
    const { data: stickyLead } = await supabase
      .from("leads")
      .insert({
        company: `Sticky Verify ${runId}`,
        domain: `sticky-verify-${runId}.example.com`,
        website_url: `https://sticky-verify-${runId}.example.com`,
      })
      .select("id, updated_at")
      .single()

    if (!stickyLead) {
      fail("requeue mode not sticky", "lead insert failed")
    } else {
      leadIds.push(stickyLead.id)
      const { data: stickyCl } = await supabase
        .from("campaign_leads")
        .insert({
          campaign_id: campaignId,
          lead_id: stickyLead.id,
          slug: `verify-sticky-${runId}`,
          status: "failed",
          current_step: "recording",
          error_code: "nav_timeout",
        })
        .select("id")
        .single()

      if (!stickyCl) {
        fail("requeue mode not sticky", "campaign_lead insert failed")
      } else {
        const baseEdit = {
          first_name: null,
          last_name: null,
          full_name: null,
          email: null,
          phone: null,
          city: null,
          state: null,
          country: null,
          merge_layout: null,
          pip_scale: null,
        }
        try {
          await updateLead(stickyCl.id, {
            ...baseEdit,
            company: `Sticky Verify ${runId}`,
            website_url: `https://sticky-changed-${runId}.example.com`,
            leads_updated_at: stickyLead.updated_at,
          })
          const afterUrlChange = await deriveRequeueModeForLead(stickyCl.id)

          await requeueLead(stickyCl.id, afterUrlChange)

          const { data: reread } = await supabase
            .from("leads")
            .select("updated_at")
            .eq("id", stickyLead.id)
            .single()
          await updateLead(stickyCl.id, {
            ...baseEdit,
            company: `Sticky Renamed ${runId}`,
            website_url: `https://sticky-changed-${runId}.example.com`,
            leads_updated_at: reread!.updated_at,
          })
          const afterNameOnly = await deriveRequeueModeForLead(stickyCl.id)

          if (afterUrlChange.kind !== "restart") {
            fail(
              "requeue mode not sticky",
              `url change derived ${JSON.stringify(afterUrlChange)}`,
            )
          } else if (afterNameOnly.kind === "restart") {
            fail(
              "requeue mode not sticky",
              "name-only edit still derived restart",
            )
          } else {
            pass("requeue mode not sticky")
          }
        } catch (error) {
          fail(
            "requeue mode not sticky",
            error instanceof Error ? error.message : String(error),
          )
        }
      }
    }

    const { data: skippedIdentity, error: skippedIdentityError } = await supabase
      .from("leads")
      .insert({
        company: "Skipped Verify",
        domain: `skipped-verify-${runId}.example.com`,
        website_url: "https://facebook.com/skipped",
      })
      .select("id")
      .single()

    if (skippedIdentityError || !skippedIdentity) {
      fail("skipped re-queue", skippedIdentityError?.message ?? "lead insert failed")
    } else {
      leadIds.push(skippedIdentity.id)
      const { data: skippedLead, error: skippedLeadError } = await supabase
        .from("campaign_leads")
        .insert({
          campaign_id: campaignId,
          lead_id: skippedIdentity.id,
          slug: `verify-skipped-${runId}`,
          status: "skipped",
          error_code: "not_a_website",
          error_detail: "Social profile or directory listing only.",
          current_step: "recording",
        })
        .select("id")
        .single()

      if (skippedLeadError || !skippedLead) {
        fail("skipped re-queue", skippedLeadError?.message ?? "cl insert failed")
      } else {
        await supabase
          .from("leads")
          .update({ website_url: "https://acme-verify.example.com" })
          .eq("id", skippedIdentity.id)

        try {
          // Drive the same path the drawer button does. Calling
          // retryCampaignLead directly here would skip the derivation, which is
          // exactly where this used to resolve to resume/restart and 409 —
          // `canRetry` admits `skipped` only for step=recording (D38/D39).
          const mode = await deriveRequeueModeForLead(skippedLead.id)
          if (mode.kind !== "step" || mode.step !== "recording") {
            fail("skipped re-queue mode", JSON.stringify(mode))
          } else {
            pass("skipped re-queue mode")
          }

          await requeueLead(skippedLead.id, mode)
          const { data: requeued } = await supabase
            .from("campaign_leads")
            .select("status, error_code, current_step")
            .eq("id", skippedLead.id)
            .single()
          if (
            requeued?.status === "queued" &&
            requeued.error_code === null &&
            requeued.current_step === "recording"
          ) {
            pass("skipped re-queue")
          } else fail("skipped re-queue", JSON.stringify(requeued))
        } catch (error) {
          fail(
            "skipped re-queue",
            error instanceof Error ? error.message : String(error),
          )
        }
      }
    }

    const retainPath = `/verify-leads-${runId}/retain-me`
    retainedPagePaths.push(retainPath)

    const { data: unpublishTarget } = await supabase
      .from("campaign_leads")
      .select("id")
      .eq("campaign_id", campaignId)
      .is("landing_page_id", null)
      .limit(1)
      .maybeSingle()

    if (unpublishTarget) {
      const { data: lp, error: lpError } = await supabase
        .from("landing_pages")
        .insert({
          campaign_lead_id: unpublishTarget.id,
          path: `/verify-leads-${runId}/unpublish`,
          deploy_status: "live",
          html: "<html>x</html>",
          content_sha1: VALID_SHA1,
        })
        .select("id")
        .single()

      if (lpError || !lp) {
        fail("unpublish", lpError?.message ?? "landing page insert failed")
      } else {
        await supabase
          .from("campaign_leads")
          .update({
            landing_page_id: lp.id,
            netlify_url: "https://example.com/unpublish",
            status: "deployed",
          })
          .eq("id", unpublishTarget.id)

        siteSyncLeadIds.push(unpublishTarget.id)
        const { error: unpublishError } = await supabase.rpc(
          "unpublish_landing_page",
          { p_campaign_lead_id: unpublishTarget.id },
        )
        if (unpublishError) {
          fail("unpublish RPC", unpublishError.message)
        } else {
          const { data: lpRow } = await supabase
            .from("landing_pages")
            .select("deploy_status, unpublished_at")
            .eq("id", lp.id)
            .single()
          const { data: event } = await supabase
            .from("pipeline_events")
            .select("kind")
            .eq("campaign_lead_id", unpublishTarget.id)
            .eq("kind", "unpublished")
            .maybeSingle()
          const { data: marker } = await supabase
            .from("pending_site_sync")
            .select("id")
            .eq("reason", "lead_unpublish")
            .contains("meta", { campaign_lead_id: unpublishTarget.id })
            .maybeSingle()
          const { data: clRow } = await supabase
            .from("campaign_leads")
            .select("netlify_url")
            .eq("id", unpublishTarget.id)
            .single()

          if (
            lpRow?.deploy_status === "removed" &&
            lpRow.unpublished_at &&
            event &&
            marker &&
            clRow?.netlify_url
          ) {
            pass("unpublish")
          } else fail("unpublish", "state incomplete")
        }
      }
    } else fail("unpublish", "no unpublish target")

    const { data: deleteTarget } = await supabase
      .from("campaign_leads")
      .select("id, lead_id")
      .eq("campaign_id", campaignId)
      .is("landing_page_id", null)
      .limit(1)
      .maybeSingle()

    if (deleteTarget) {
      await supabase.from("recordings").insert({
        lead_id: deleteTarget.lead_id,
        local_path: `verify/${runId}/recording.mp4`,
      })

      const { data: deleteLp, error: deleteLpError } = await supabase
        .from("landing_pages")
        .insert({
          campaign_lead_id: deleteTarget.id,
          path: retainPath,
          deploy_status: "live",
          html: "<html>retain</html>",
          content_sha1: VALID_SHA1,
        })
        .select("id")
        .single()

      if (deleteLpError || !deleteLp) {
        fail("delete with retain", deleteLpError?.message ?? "lp insert failed")
      } else {
        await supabase
          .from("campaign_leads")
          .update({ landing_page_id: deleteLp.id })
          .eq("id", deleteTarget.id)

        siteSyncLeadIds.push(deleteTarget.id)
        const { error: deleteError } = await supabase.rpc(
          "delete_lead_retaining_pages",
          { p_campaign_lead_id: deleteTarget.id, p_retain: true },
        )
        if (deleteError) {
          fail("delete with retain", deleteError.message)
        } else {
          const { data: retained } = await supabase
            .from("retained_pages")
            .select("reason")
            .eq("path", retainPath)
            .maybeSingle()
          const { data: clGone } = await supabase
            .from("campaign_leads")
            .select("id")
            .eq("id", deleteTarget.id)
            .maybeSingle()

          if (retained && !clGone) pass("delete with retain")
          else fail("delete with retain", `retained=${!!retained} clGone=${!!clGone}`)
        }
      }
    } else fail("delete with retain", "no delete target")

    const { data: mediaLead, error: mediaLeadError } = await supabase
      .from("leads")
      .insert({
        company: `Verify Media ${runId}`,
        domain: `verify-media-${runId}.example.com`,
      })
      .select("id")
      .single()

    if (mediaLeadError || !mediaLead) {
      fail("media setup", mediaLeadError?.message ?? "lead insert failed")
    } else {
      leadIds.push(mediaLead.id)
      const { data: mediaCl, error: mediaClError } = await supabase
        .from("campaign_leads")
        .insert({
          campaign_id: campaignId,
          lead_id: mediaLead.id,
          slug: `verify-media-${runId}`,
          status: "queued",
          current_step: "recording",
        })
        .select("id")
        .single()

      if (mediaClError || !mediaCl) {
        fail("media setup", mediaClError?.message ?? "cl insert failed")
      } else {
        // The row alone is not enough: serveLocalFile stat()s the path, so
        // without real bytes on disk the 200 and Range legs 404 and prove
        // nothing. Larger than the 1024-byte Range window on purpose.
        mkdirSync(path.dirname(mediaAbsPath), { recursive: true })
        writeFileSync(mediaAbsPath, Buffer.alloc(4096, 7))

        await supabase.from("recordings").insert({
          lead_id: mediaLead.id,
          local_path: `verify/${runId}/media.mp4`,
          screenshot_before_path: `verify/${runId}/before.txt`,
        })
        const { data: mediaRecording } = await supabase
          .from("recordings")
          .select("id")
          .eq("lead_id", mediaLead.id)
          .single()
        if (mediaRecording) {
          await supabase
            .from("campaign_leads")
            .update({ recording_id: mediaRecording.id })
            .eq("id", mediaCl.id)
        }

        if (await probeServer()) {
          const login = await loginSessionCookie(env.APP_PASSWORD)
          if ("reason" in login) {
            fail("GET /api/leads/[id]/recording", login.reason)
          } else {
            const cookieHeader = `${SESSION_COOKIE_NAME}=${login.cookie}`
            const recordingResponse = await fetch(
              `${BASE_URL}/api/leads/${mediaCl.id}/recording`,
              { headers: { Cookie: cookieHeader } },
            )
            if (recordingResponse.status !== 200) {
              fail(
                "GET /api/leads/[id]/recording",
                `status=${recordingResponse.status}`,
              )
            } else if (
              recordingResponse.headers.get("cache-control") !==
              "private, no-store"
            ) {
              fail("GET /api/leads/[id]/recording", "missing Cache-Control")
            } else pass("GET /api/leads/[id]/recording")

            const rangeResponse = await fetch(
              `${BASE_URL}/api/leads/${mediaCl.id}/recording`,
              {
                headers: { Cookie: cookieHeader, Range: "bytes=0-1023" },
              },
            )
            if (rangeResponse.status !== 206) {
              fail(
                "GET /api/leads/[id]/recording range",
                `status=${rangeResponse.status}`,
              )
            } else if (
              !rangeResponse.headers.get("content-range")?.includes("bytes 0-1023/")
            ) {
              fail("GET /api/leads/[id]/recording range", "missing Content-Range")
            } else pass("GET /api/leads/[id]/recording range")

            const unauthResponse = await fetch(
              `${BASE_URL}/api/leads/${mediaCl.id}/recording`,
            )
            if (unauthResponse.status !== 401) {
              fail(
                "GET /api/leads/[id]/recording unauth",
                `status=${unauthResponse.status}`,
              )
            } else pass("GET /api/leads/[id]/recording unauth")

            // Assert the setup landed. Unchecked, a failed update leaves the
            // valid path in place and the route correctly serves 200 — so the
            // leg reports a containment hole that does not exist, or worse
            // passes for the wrong reason once the file is missing.
            const { data: traversalRow, error: traversalSetupError } =
              await supabase
                .from("recordings")
                .update({ local_path: "../../escaped-by-verify.mp4" })
                .eq("lead_id", mediaLead.id)
                .select("local_path")
                .maybeSingle()

            if (traversalSetupError || traversalRow?.local_path !== "../../escaped-by-verify.mp4") {
              fail(
                "media path containment",
                `setup did not apply: ${traversalSetupError?.message ?? JSON.stringify(traversalRow)}`,
              )
            } else {
              const traversalResponse = await fetch(
                `${BASE_URL}/api/leads/${mediaCl.id}/recording`,
                { headers: { Cookie: cookieHeader } },
              )
              if (traversalResponse.status !== 404) {
                fail(
                  "media path containment",
                  `status=${traversalResponse.status}`,
                )
              } else pass("media path containment")
            }

            await supabase
              .from("recordings")
              .update({ local_path: `verify/${runId}/media.mp4` })
              .eq("lead_id", mediaLead.id)

            const badExtResponse = await fetch(
              `${BASE_URL}/api/leads/${mediaCl.id}/screenshot?which=before`,
              { headers: { Cookie: cookieHeader } },
            )
            if (badExtResponse.status !== 404) {
              fail(
                "GET /api/leads/[id]/screenshot non-image",
                `status=${badExtResponse.status}`,
              )
            } else pass("GET /api/leads/[id]/screenshot non-image")
          }
        } else {
          skip("GET /api/leads/[id]/recording", "dev server not running")
          skip("GET /api/leads/[id]/recording range", "dev server not running")
          skip("GET /api/leads/[id]/recording unauth", "dev server not running")
          skip("media path containment", "dev server not running")
          skip("GET /api/leads/[id]/screenshot non-image", "dev server not running")
        }
      }
    }

    if (await probeServer()) {
      const login = await loginSessionCookie(env.APP_PASSWORD)
      if ("reason" in login) {
        fail("leads stream changed", login.reason)
        fail("leads stream scope", login.reason)
      } else {
        const cookieHeader = `${SESSION_COOKIE_NAME}=${login.cookie}`
        const streamUrl = `${BASE_URL}/api/stream/leads?campaign=${campaignId}`
        const controller = new AbortController()
        const streamResponse = await fetch(streamUrl, {
          signal: controller.signal,
          headers: { Cookie: cookieHeader },
        })

        if (!streamResponse.ok || !streamResponse.body) {
          fail("leads stream changed", `status ${streamResponse.status}`)
          fail("leads stream scope", "stream unavailable")
        } else {
          const reader = streamResponse.body.getReader()
          const decoder = new TextDecoder()
          let buffer = ""
          await new Promise((resolve) => setTimeout(resolve, 2_000))

          const { data: streamTarget } = await supabase
            .from("campaign_leads")
            .select("id")
            .eq("campaign_id", campaignId)
            .eq("status", "queued")
            .limit(1)
            .single()

          await supabase
            .from("campaign_leads")
            .update({ status: "processing" })
            .eq("id", streamTarget!.id)

          let sawChanged = false
          const deadline = performance.now() + 5_000
          while (!sawChanged && performance.now() < deadline) {
            const { events, remainder } = parseSseEvents(buffer)
            buffer = remainder
            for (const frame of events) {
              if (frame.event !== "changed") continue
              const payload = JSON.parse(frame.data) as { ids?: string[] }
              if (payload.ids?.includes(streamTarget!.id)) {
                sawChanged = true
                break
              }
            }
            if (sawChanged) break
            const { done, value } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })
          }
          controller.abort()

          if (sawChanged) pass("leads stream changed")
          else fail("leads stream changed", "no changed frame")

          const otherController = new AbortController()
          const otherStream = await fetch(streamUrl, {
            signal: otherController.signal,
            headers: { Cookie: cookieHeader },
          })
          if (!otherStream.ok || !otherStream.body) {
            fail("leads stream scope", `open status ${otherStream.status}`)
          } else {
            await new Promise((resolve) => setTimeout(resolve, 2_000))
            const { data: otherLead } = await supabase
              .from("leads")
              .insert({
                company: `Verify Other Campaign ${runId}`,
                domain: `verify-other-${runId}.example.com`,
              })
              .select("id")
              .single()
            if (otherLead) {
              leadIds.push(otherLead.id)
              await supabase.from("campaign_leads").insert({
                campaign_id: otherCampaignId,
                lead_id: otherLead.id,
                slug: `verify-other-cl-${runId}`,
                status: "queued",
                current_step: "recording",
                queued_at: new Date().toISOString(),
              })
            }

            const otherReader = otherStream.body.getReader()
            const otherDecoder = new TextDecoder()
            let otherBuffer = ""
            let leakedInsert = false
            const scopeDeadline = performance.now() + 5_000
            while (!leakedInsert && performance.now() < scopeDeadline) {
              const { events, remainder } = parseSseEvents(otherBuffer)
              otherBuffer = remainder
              for (const frame of events) {
                if (frame.event !== "changed") continue
                const payload = JSON.parse(frame.data) as {
                  inserted?: string[]
                }
                if ((payload.inserted?.length ?? 0) > 0) {
                  leakedInsert = true
                  break
                }
              }
              if (leakedInsert) break
              const { done, value } = await otherReader.read()
              if (done) break
              otherBuffer += otherDecoder.decode(value, { stream: true })
            }
            otherController.abort()

            if (leakedInsert) fail("leads stream scope", "other-campaign insert leaked")
            else pass("leads stream scope")
          }
        }
      }
    } else {
      skip("leads stream changed", "dev server not running")
      skip("leads stream scope", "dev server not running")
    }

    // Runs last and in-process: it kills the shared Realtime socket and bumps
    // `updated_at` on a fixture row, so the sort, filter and perf legs above
    // must already have been asserted. Needs no dev server — the subject is
    // this process's own stream singleton.
    const { data: pokeRow } = await supabase
      .from("campaign_leads")
      .select("id")
      .eq("campaign_id", campaignId!)
      .limit(1)
      .maybeSingle()

    if (pokeRow) {
      await checkLeadsChannelLifecycle(supabase, pokeRow.id)
    } else {
      skip("leads channel emits resync on join", "no fixture lead to poke")
      skip("leads channel resyncs after a socket kill", "no fixture lead to poke")
      skip("leads channel teardown does not recurse", "no fixture lead to poke")
      skip("leads channel rebuilt after teardown", "no fixture lead to poke")
    }
  } finally {
    rmSync(mediaDirAbs, { recursive: true, force: true })
    for (const retainedPath of retainedPagePaths) {
      await supabase.from("retained_pages").delete().eq("path", retainedPath)
    }
    for (const id of siteSyncLeadIds) {
      await supabase
        .from("pending_site_sync")
        .delete()
        .eq("meta->>campaign_lead_id", id)
    }
    if (otherCampaignId) {
      await supabase.from("campaigns").delete().eq("id", otherCampaignId)
    }
    if (campaignId) {
      await supabase.from("campaigns").delete().eq("id", campaignId)
    }
    for (const id of leadIds) {
      await supabase.from("leads").delete().eq("id", id)
    }

    // Strictly after the row deletions above: the sweep decides what to drop by
    // asking which campaign_leads still exist, so running it first sees every
    // fixture row alive and removes nothing.
    await removeJobsThisRunOrphaned(supabase, pendingJobIdsAtStart)

    await closeQueueConnections()
  }

  const passed = results.filter((r) => r.state === "pass").length
  const skipped = results.filter((r) => r.state === "skip").length
  const failed = results.filter((r) => r.state === "fail").length
  const asserted = results.length - skipped
  console.log(
    `\n${passed}/${asserted} checks passed${skipped > 0 ? `, ${skipped} skipped` : ""}, worst perf ${worstPerfMs} ms`,
  )
  if (failed > 0) process.exitCode = 1

  // Every retry leg enqueues, which constructs the shared ioredis client. With
  // Redis down its reconnect loop keeps the event loop alive even after
  // closeQueueConnections(), so the script printed this summary and then hung
  // forever (Phase 11 findings 17/18). `process.exit` is safe *here* and only
  // here: teardown above is fully awaited, so there is no in-flight work left
  // to truncate — which was finding 12's objection to calling it mid-run.
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
