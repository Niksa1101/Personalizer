/**
 * Phase 12 dashboard verification — real Supabase, self-cleaning.
 */


import { createClient } from "@supabase/supabase-js"

import type { Database } from "../lib/database.types"
import { subscribeDashboardStream } from "../lib/dashboard-stream"
import {
  dashboardCountsSchema,
  type DashboardScope,
} from "../lib/dashboard-types"
import { assertEnvOrExit } from "../lib/env-node"
import { closeQueueConnections } from "../lib/queue"
import { getSupabaseAdmin } from "../lib/supabase"
import { SESSION_COOKIE_NAME } from "../lib/session"

interface CheckResult {
  name: string
  state: "pass" | "fail" | "skip"
  detail: string
}

const results: CheckResult[] = []
const BASE_URL = "http://127.0.0.1:3000"

function pass(name: string, detail = "ok"): void {
  results.push({ name, state: "pass", detail })
  console.log(`PASS  ${name}${detail === "ok" ? "" : ` — ${detail}`}`)
}

function fail(name: string, detail: string): void {
  results.push({ name, state: "fail", detail })
  console.error(`FAIL  ${name} — ${detail}`)
}

function skip(name: string, reason: string): void {
  results.push({ name, state: "skip", detail: reason })
  console.log(`SKIP  ${name} — ${reason}`)
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
      if (line.startsWith("event:")) {
        event = line.slice(6).trim()
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trim())
      }
    }

    if (dataLines.length > 0) {
      events.push({ event, data: dataLines.join("\n") })
    }
  }

  return { events, remainder }
}

async function readSnapshotEvent(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decoder: TextDecoder,
  initialBuffer = "",
): Promise<{ snapshot: unknown; buffer: string } | null> {
  let buffer = initialBuffer

  while (true) {
    const { events, remainder } = parseSseEvents(buffer)
    buffer = remainder

    for (const frame of events) {
      if (frame.event === "snapshot") {
        return { snapshot: JSON.parse(frame.data), buffer }
      }
    }

    const { done, value } = await reader.read()
    if (done) return null
    buffer += decoder.decode(value, { stream: true })
  }
}

type LeadStatus = Database["public"]["Enums"]["lead_status"]

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
    const name = pair.slice(0, eq).trim()
    const value = pair.slice(eq + 1).trim()
    jar.set(name, value)
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

/** Returns the session cookie, or a reason string explaining the failure —
 *  an opaque "could not log in" costs a whole debugging round trip. */
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

  const cookies = parseCookies(getSetCookie(response))
  const cookie = cookies.get(SESSION_COOKIE_NAME)
  if (!cookie) {
    return {
      reason: `login 200 but no ${SESSION_COOKIE_NAME} cookie in Set-Cookie`,
    }
  }
  return { cookie }
}

const CHANNEL_JOIN_MS = 8_000
const CHANNEL_PUSH_MS = 10_000
/** `RESNAPSHOT_MS` in lib/dashboard-stream.ts. A push inside this window came
 *  from Realtime, not from the safety-net timer — which is what makes the
 *  recovery legs below assert recovery rather than "something eventually fired". */
const RESNAPSHOT_MS = 15_000

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * The stream singleton's own handle (`lib/dashboard-stream.ts` keys it off the
 * global symbol registry). Join is read from the channel rather than from the
 * first pushed snapshot on purpose: the first push *is* the SUBSCRIBED
 * catch-up tick, so inferring join from it would make every leg below report
 * "never joined" the moment that tick regressed — burying the actual defect.
 */
function channelJoined(): boolean {
  const state = (
    globalThis as unknown as Record<symbol, { channel?: { state?: string } | null }>
  )[Symbol.for("personalizer.dashboardStream")]
  return state?.channel?.state === "joined"
}

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

/**
 * Drain the SUBSCRIBED catch-up tick before a leg samples its push counter.
 * Join is observable a beat before that tick lands, so a counter captured
 * straight after `channelJoined()` would see the join's own snapshot and read
 * it as the write's. Deliberately does not require the tick — its absence is
 * what leg 1 is there to detect.
 */
async function settleAfterJoin(pushes: () => number): Promise<void> {
  await waitFor(() => pushes() > 0, 2_000)
  await sleep(800)
}

/**
 * Phase 12's second exit criterion — "killing the socket falls back to polling
 * and recovers" — was previously asserted only against a **healthy** channel.
 * Every SSE leg above opens a stream, reads it, and aborts the *client* side;
 * nothing ever pushed the server's Realtime channel into an error or a
 * teardown. That is why the `removeChannel()` stack overflow (Phase 13 findings
 * 13/14) sat latent through an 18/18 run.
 *
 * These legs drive `lib/dashboard-stream.ts` in-process, because the module is a
 * module-scope singleton and the honest place to kill its socket is a process
 * that owns it. Over HTTP the same defect is invisible: the host swallows the
 * RangeError and `state.channel` still lands on null, so the next connection
 * rebuilds the channel and every observable check stays green.
 */
async function checkChannelLifecycle(
  supabase: ReturnType<typeof createClient<Database>>,
  scope: DashboardScope,
  pokeLeadId: string,
): Promise<void> {
  // The recursion surfaces as a burst of unhandled RangeErrors rather than a
  // throw at the call site — `removeChannel()` re-enters through the promise
  // that supabase-js returns, so nothing is on the stack to catch it.
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
    // ---- leg 1: a killed websocket still delivers -------------------------
    const first = new AbortController()
    let pushes = 0
    const unsubscribeFirst = subscribeDashboardStream(scope, {
      enqueue: () => {
        pushes += 1
      },
      onOverflow: () => undefined,
      signal: first.signal,
    })

    const joined = await waitFor(channelJoined, CHANNEL_JOIN_MS)
    if (!joined) {
      fail("realtime socket kill recovers", "channel never joined")
      fail("channel teardown does not recurse", "channel never joined")
      fail("channel rebuilt after teardown", "channel never joined")
      unsubscribeFirst()
      first.abort()
      return
    }

    await settleAfterJoin(() => pushes)
    getSupabaseAdmin().realtime.disconnect()

    const beforeKill = pushes
    const killWriteAt = Date.now()
    await poke()
    const recovered = await waitFor(() => pushes > beforeKill, CHANNEL_PUSH_MS)
    const recoveryMs = Date.now() - killWriteAt

    if (!recovered) {
      fail(
        "realtime socket kill recovers",
        `no snapshot within ${CHANNEL_PUSH_MS}ms of a write after socket kill`,
      )
    } else if (recoveryMs >= RESNAPSHOT_MS) {
      // Delivered, but late enough that the safety net — not the rebuilt
      // channel — is the plausible source. That is a degraded dashboard, not a
      // recovered one.
      fail("realtime socket kill recovers", `${recoveryMs}ms — safety-net window`)
    } else {
      pass("realtime socket kill recovers", `${recoveryMs}ms`)
    }

    // ---- leg 2: teardown to zero subscribers does not recurse -------------
    rangeErrors.length = 0
    unsubscribeFirst()
    first.abort()
    // The re-entrant CLOSED dispatch lands a few microtask turns later.
    await sleep(1_000)

    if (rangeErrors.length > 0) {
      fail(
        "channel teardown does not recurse",
        `${rangeErrors.length} unhandled RangeError(s) — ${rangeErrors[0]}`,
      )
    } else {
      pass("channel teardown does not recurse")
    }

    // ---- leg 3: the next subscriber gets a live channel, not a dead one ----
    const second = new AbortController()
    let repushes = 0
    const unsubscribeSecond = subscribeDashboardStream(scope, {
      enqueue: () => {
        repushes += 1
      },
      onOverflow: () => undefined,
      signal: second.signal,
    })

    const rejoined = await waitFor(channelJoined, CHANNEL_JOIN_MS)
    if (!rejoined) {
      fail("channel rebuilt after teardown", "channel never rejoined")
    } else {
      await settleAfterJoin(() => repushes)
      const beforeRebuild = repushes
      const rebuildWriteAt = Date.now()
      await poke()
      const pushedAgain = await waitFor(
        () => repushes > beforeRebuild,
        CHANNEL_PUSH_MS,
      )
      const rebuildMs = Date.now() - rebuildWriteAt

      if (!pushedAgain) {
        // Exactly the pre-fix state: `state.channel` never cleared, so
        // `ensureChannel()` short-circuits forever and no write is ever pushed
        // again for the life of the process.
        fail(
          "channel rebuilt after teardown",
          `no Realtime push within ${CHANNEL_PUSH_MS}ms`,
        )
      } else if (rebuildMs >= RESNAPSHOT_MS) {
        fail("channel rebuilt after teardown", `${rebuildMs}ms — safety-net window`)
      } else {
        pass("channel rebuilt after teardown", `${rebuildMs}ms`)
      }
    }

    unsubscribeSecond()
    second.abort()
    await sleep(500)
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

  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim()
  const anon = anonKey
    ? createClient<Database>(env.NEXT_PUBLIC_SUPABASE_URL, anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      })
    : null

  const runId = Date.now().toString(36)
  let campaignId: string | null = null
  let batchId: string | null = null
  const leadIds: string[] = []
  const campaignLeadIds: string[] = []
  const extraCampaignIds: string[] = []

  let lastSeedError = ""

  /** Bare campaign for a leg that must not touch the main fixture's counts. */
  async function seedCampaign(suffix: string): Promise<string | null> {
    const { data, error } = await supabase
      .from("campaigns")
      .insert({
        name: `Verify Dashboard ${suffix}`,
        slug: `verify-dashboard-${suffix}`,
        landing_template: "<html></html>",
        merge_layout: "bubble_br",
        pip_scale: 0.2,
        viewport_width: 1920,
        viewport_height: 1080,
        nav_timeout_ms: 120_000,
      })
      .select("id")
      .single()

    if (error || !data) {
      lastSeedError = error?.message ?? "insert returned no row"
      return null
    }
    return data.id
  }

  /** Lead + campaign_lead pair, registered for teardown. */
  async function seedCampaignLead(
    targetCampaignId: string,
    suffix: string,
    fields: Partial<
      Database["public"]["Tables"]["campaign_leads"]["Insert"]
    > & { status: LeadStatus },
  ): Promise<string | null> {
    const { data: lead, error: leadError } = await supabase
      .from("leads")
      .insert({
        company: `Verify Dashboard ${suffix}`,
        full_name: `Verify ${suffix}`,
        domain: `verify-dashboard-${suffix}.example.com`,
      })
      .select("id")
      .single()

    if (leadError || !lead) return null
    leadIds.push(lead.id)

    const { data: campaignLead, error: clError } = await supabase
      .from("campaign_leads")
      .insert({
        campaign_id: targetCampaignId,
        lead_id: lead.id,
        slug: `verify-${suffix}`,
        queued_at: new Date().toISOString(),
        ...fields,
      })
      .select("id")
      .single()

    if (clError || !campaignLead) return null
    return campaignLead.id
  }

  try {
    const beforeAll = await supabase.rpc("dashboard_counts", {
      p_campaign_id: undefined,
      p_include_archived: false,
    })
    if (beforeAll.error) {
      fail("dashboard_counts exists", beforeAll.error.message)
      return
    }
    pass("dashboard_counts exists")

    const parsedBeforeAll = dashboardCountsSchema.safeParse(beforeAll.data)
    if (!parsedBeforeAll.success) {
      fail("all-campaigns shape", parsedBeforeAll.error.message)
      return
    }

    const { data: campaign, error: campaignError } = await supabase
      .from("campaigns")
      .insert({
        name: `Verify Dashboard ${runId}`,
        slug: `verify-dashboard-${runId}`,
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
      return
    }
    campaignId = campaign.id
    pass("seed campaign")

    const { data: batch, error: batchError } = await supabase
      .from("import_batches")
      .insert({
        campaign_id: campaignId,
        filename: "verify.csv",
        slug: `verify-dashboard-batch-${runId}`,
        row_count: 7,
        imported_count: 7,
      })
      .select("id")
      .single()

    if (batchError || !batch) {
      fail("seed batch", batchError?.message ?? "insert failed")
      return
    }
    batchId = batch.id

    const statuses: LeadStatus[] = [
      "queued",
      "processing",
      "paused",
      "deployed",
      "ready",
      "failed",
      "skipped",
    ]

    for (const status of statuses) {
      const { data: lead, error: leadError } = await supabase
        .from("leads")
        .insert({
          company: `Verify Dashboard ${status} ${runId}`,
          full_name: `Verify ${status}`,
          domain: `verify-dashboard-${status}-${runId}.example.com`,
        })
        .select("id")
        .single()

      if (leadError || !lead) {
        fail(`seed lead ${status}`, leadError?.message ?? "insert failed")
        return
      }
      leadIds.push(lead.id)

      const { data: campaignLead, error: clError } = await supabase
        .from("campaign_leads")
        .insert({
          campaign_id: campaignId,
          lead_id: lead.id,
          batch_id: batchId,
          slug: `verify-${status}-${runId}`,
          status,
          current_step:
            status === "processing"
              ? "merge"
              : status === "failed"
                ? "recording"
                : "recording",
          error_code:
            status === "failed"
              ? "dns_failure"
              : status === "paused"
                ? "intro_missing"
                : null,
          queued_at: new Date().toISOString(),
          started_at:
            status === "deployed" || status === "ready"
              ? new Date(Date.now() - 120_000).toISOString()
              : null,
          deployed_at:
            status === "deployed" || status === "ready"
              ? new Date().toISOString()
              : null,
          netlify_url:
            status === "deployed" || status === "ready"
              ? `https://example.com/${status}-${runId}`
              : null,
          deployed_dry_run: false,
        })
        .select("id")
        .single()

      if (clError || !campaignLead) {
        fail(`seed campaign lead ${status}`, clError?.message ?? "insert failed")
        return
      }
      campaignLeadIds.push(campaignLead.id)
    }
    pass("seed status distribution")

    const { data: directCounts } = await supabase
      .from("campaign_leads")
      .select("status")
      .eq("campaign_id", campaignId)

    const expected = Object.fromEntries(statuses.map((status) => [status, 0])) as Record<
      LeadStatus,
      number
    >
    for (const row of directCounts ?? []) {
      expected[row.status as LeadStatus] += 1
    }

    const { data: scopedCounts, error: scopedError } = await supabase.rpc(
      "dashboard_counts",
      {
        p_campaign_id: campaignId,
        p_include_archived: false,
      },
    )

    if (scopedError) {
      fail("per-campaign counts exact", scopedError.message)
    } else {
      const parsed = dashboardCountsSchema.parse(scopedCounts)
      const matches = statuses.every(
        (status) => parsed.tiles[status] === expected[status],
      )
      if (matches) pass("per-campaign counts exact")
      else fail("per-campaign counts exact", JSON.stringify(parsed.tiles))
    }

    const afterAll = dashboardCountsSchema.parse(
      (
        await supabase.rpc("dashboard_counts", {
          p_campaign_id: undefined,
          p_include_archived: false,
        })
      ).data,
    )

    let deltaOk = true
    for (const status of statuses) {
      const delta = afterAll.tiles[status] - parsedBeforeAll.data.tiles[status]
      if (delta !== expected[status]) {
        fail(
          "all-campaigns delta",
          `${status}: expected +${expected[status]}, got +${delta}`,
        )
        deltaOk = false
        break
      }
    }
    if (deltaOk) pass("all-campaigns delta")

    await supabase
      .from("campaigns")
      .update({ archived_at: new Date().toISOString() })
      .eq("id", campaignId)

    const archivedHidden = dashboardCountsSchema.parse(
      (
        await supabase.rpc("dashboard_counts", {
          p_campaign_id: campaignId,
          p_include_archived: false,
        })
      ).data,
    )
    const archivedVisible = dashboardCountsSchema.parse(
      (
        await supabase.rpc("dashboard_counts", {
          p_campaign_id: campaignId,
          p_include_archived: true,
        })
      ).data,
    )

    if (archivedHidden.tiles.queued === 0 && archivedVisible.tiles.queued === 1) {
      pass("archived scoping")
    } else {
      fail(
        "archived scoping",
        `hidden queued=${archivedHidden.tiles.queued}, visible queued=${archivedVisible.tiles.queued}`,
      )
    }

    await supabase
      .from("campaigns")
      .update({ archived_at: null })
      .eq("id", campaignId)

    const readyLeadId = campaignLeadIds[statuses.indexOf("ready")]
    const { data: etaBeforePause } = await supabase.rpc("dashboard_counts", {
      p_campaign_id: undefined,
      p_include_archived: false,
    })
    const samplesBefore = dashboardCountsSchema.parse(etaBeforePause).eta_samples.length

    await supabase.from("pipeline_events").insert({
      campaign_lead_id: readyLeadId,
      kind: "paused",
      message: "verify dashboard paused sample exclusion",
    })

    const { data: etaAfterPause } = await supabase.rpc("dashboard_counts", {
      p_campaign_id: undefined,
      p_include_archived: false,
    })
    const samplesAfterPause = dashboardCountsSchema.parse(etaAfterPause).eta_samples.length
    if (samplesAfterPause <= samplesBefore) {
      pass("eta paused exclusion")
    } else {
      fail("eta paused exclusion", `samples grew ${samplesBefore} -> ${samplesAfterPause}`)
    }

    const deployedLeadId = campaignLeadIds[statuses.indexOf("deployed")]
    await supabase
      .from("campaign_leads")
      .update({ deployed_dry_run: true })
      .eq("id", deployedLeadId)

    const dryRunOnly = dashboardCountsSchema.parse(
      (
        await supabase.rpc("dashboard_counts", {
          p_campaign_id: campaignId,
          p_include_archived: false,
        })
      ).data,
    )
    if (dryRunOnly.dry_run_count >= 1) {
      pass("dry-run tile annotation source")
    } else {
      fail("dry-run tile annotation source", `dry_run_count=${dryRunOnly.dry_run_count}`)
    }

    const processingId = campaignLeadIds[statuses.indexOf("processing")]
    const processingSnapshot = dashboardCountsSchema.parse(
      (
        await supabase.rpc("dashboard_counts", {
          p_campaign_id: campaignId,
          p_include_archived: false,
        })
      ).data,
    )
    const processingRow = processingSnapshot.processing.find((row) => row.id === processingId)
    if (processingRow?.step_started_at == null) {
      pass("step-start guard without event")
    } else {
      fail("step-start guard without event", processingRow.step_started_at)
    }

    await supabase.from("pipeline_events").insert({
      campaign_lead_id: processingId,
      kind: "step_started",
      step: "recording",
      message: "stale previous step",
    })

    const staleSnapshot = dashboardCountsSchema.parse(
      (
        await supabase.rpc("dashboard_counts", {
          p_campaign_id: campaignId,
          p_include_archived: false,
        })
      ).data,
    )
    const staleRow = staleSnapshot.processing.find((row) => row.id === processingId)
    if (staleRow?.step_started_at == null) {
      pass("step-start guard ignores previous step")
    } else {
      fail("step-start guard ignores previous step", staleRow.step_started_at)
    }

    const stepStartedAt = new Date().toISOString()
    await supabase.from("pipeline_events").insert({
      campaign_lead_id: processingId,
      kind: "step_started",
      step: "merge",
      message: "current step started",
      created_at: stepStartedAt,
    })

    const currentSnapshot = dashboardCountsSchema.parse(
      (
        await supabase.rpc("dashboard_counts", {
          p_campaign_id: campaignId,
          p_include_archived: false,
        })
      ).data,
    )
    const currentRow = currentSnapshot.processing.find((row) => row.id === processingId)
    if (
      currentRow?.step_started_at != null &&
      Date.parse(currentRow.step_started_at) === Date.parse(stepStartedAt)
    ) {
      pass("step-start guard picks current step")
    } else {
      fail(
        "step-start guard picks current step",
        `expected ${stepStartedAt}, got ${currentRow?.step_started_at ?? "null"}`,
      )
    }

    // --- Phase 12 review fixes: processing cap/order and ETA scoping ---
    // These run in their own campaigns so they cannot perturb the delta legs
    // above or the SSE legs below (which assert on the first campaign's scope).

    const orderCampaignId = await seedCampaign(`order-${runId}`)
    if (!orderCampaignId) {
      fail("processing capped and ordered longest-first", `could not seed campaign: ${lastSeedError}`)
    } else {
      extraCampaignIds.push(orderCampaignId)

      // 12 processing leads; index 0 started longest ago, index 11 most recently.
      const PROCESSING_FIXTURES = 12
      const stepStarts: string[] = []
      for (let index = 0; index < PROCESSING_FIXTURES; index += 1) {
        const startedAt = new Date(
          Date.now() - (PROCESSING_FIXTURES - index) * 60_000,
        ).toISOString()
        stepStarts.push(startedAt)

        const clId = await seedCampaignLead(orderCampaignId, `order-${index}-${runId}`, {
          status: "processing",
          current_step: "merge",
        })
        if (!clId) {
          fail("processing capped and ordered longest-first", `seed row ${index} failed`)
          return
        }
        await supabase.from("pipeline_events").insert({
          campaign_lead_id: clId,
          kind: "step_started",
          step: "merge",
          message: "verify ordering fixture",
          created_at: startedAt,
        })
      }

      const ordered = dashboardCountsSchema.parse(
        (
          await supabase.rpc("dashboard_counts", {
            p_campaign_id: orderCampaignId,
            p_include_archived: false,
          })
        ).data,
      )

      const starts = ordered.processing.map((row) =>
        row.step_started_at ? Date.parse(row.step_started_at) : Number.NaN,
      )
      const isAscending = starts.every(
        (value, index) => index === 0 || starts[index - 1]! <= value,
      )
      const oldestFirst = starts[0] === Date.parse(stepStarts[0]!)
      const newestExcluded = !ordered.processing.some(
        (row) =>
          row.step_started_at != null &&
          Date.parse(row.step_started_at) ===
            Date.parse(stepStarts[PROCESSING_FIXTURES - 1]!),
      )

      if (
        ordered.processing.length === 10 &&
        ordered.processing_total === PROCESSING_FIXTURES &&
        isAscending &&
        oldestFirst &&
        newestExcluded
      ) {
        pass(
          "processing capped and ordered longest-first",
          `10 of ${ordered.processing_total}, oldest first`,
        )
      } else {
        fail(
          "processing capped and ordered longest-first",
          `len=${ordered.processing.length} total=${ordered.processing_total} ascending=${isAscending} oldestFirst=${oldestFirst} newestExcluded=${newestExcluded}`,
        )
      }
    }

    const etaCampaignId = await seedCampaign(`eta-${runId}`)
    if (!etaCampaignId) {
      fail("eta samples campaign-scoped", `could not seed campaign: ${lastSeedError}`)
    } else {
      extraCampaignIds.push(etaCampaignId)

      // Three clean deployed leads at exactly 300 s. If ETA were still global,
      // other campaigns' durations would leak into the scoped sample set.
      const ETA_SECONDS = 300
      for (let index = 0; index < 3; index += 1) {
        const deployedAt = new Date(Date.now() - index * 1_000)
        const startedAt = new Date(deployedAt.getTime() - ETA_SECONDS * 1_000)
        const clId = await seedCampaignLead(etaCampaignId, `eta-${index}-${runId}`, {
          status: "deployed",
          current_step: "deploy",
          started_at: startedAt.toISOString(),
          deployed_at: deployedAt.toISOString(),
          deployed_dry_run: false,
          netlify_url: `https://example.com/eta-${index}-${runId}`,
        })
        if (!clId) {
          fail("eta samples campaign-scoped", `seed row ${index} failed`)
          return
        }
      }

      const scopedEta = dashboardCountsSchema.parse(
        (
          await supabase.rpc("dashboard_counts", {
            p_campaign_id: etaCampaignId,
            p_include_archived: false,
          })
        ).data,
      )

      if (
        scopedEta.eta_samples.length === 3 &&
        scopedEta.eta_samples.every((value) => value === ETA_SECONDS)
      ) {
        pass("eta samples campaign-scoped", `3 × ${ETA_SECONDS}s`)
      } else {
        fail(
          "eta samples campaign-scoped",
          `got ${JSON.stringify(scopedEta.eta_samples)}`,
        )
      }

      // A campaign with fewer than 3 clean samples must borrow the global set.
      const fallbackCampaignId = await seedCampaign(`eta-fallback-${runId}`)
      if (!fallbackCampaignId) {
        fail("eta samples fall back to global", `could not seed campaign: ${lastSeedError}`)
      } else {
        extraCampaignIds.push(fallbackCampaignId)

        const LONE_SECONDS = 4242
        const deployedAt = new Date()
        const clId = await seedCampaignLead(
          fallbackCampaignId,
          `eta-lone-${runId}`,
          {
            status: "deployed",
            current_step: "deploy",
            started_at: new Date(
              deployedAt.getTime() - LONE_SECONDS * 1_000,
            ).toISOString(),
            deployed_at: deployedAt.toISOString(),
            deployed_dry_run: false,
            netlify_url: `https://example.com/eta-lone-${runId}`,
          },
        )

        if (!clId) {
          fail("eta samples fall back to global", "seed row failed")
        } else {
          const fallbackEta = dashboardCountsSchema.parse(
            (
              await supabase.rpc("dashboard_counts", {
                p_campaign_id: fallbackCampaignId,
                p_include_archived: false,
              })
            ).data,
          )

          const borrowedGlobal =
            fallbackEta.eta_samples.includes(ETA_SECONDS) &&
            !(
              fallbackEta.eta_samples.length === 1 &&
              fallbackEta.eta_samples[0] === LONE_SECONDS
            )

          if (borrowedGlobal) {
            pass(
              "eta samples fall back to global",
              `${fallbackEta.eta_samples.length} samples, includes ${ETA_SECONDS}s`,
            )
          } else {
            fail(
              "eta samples fall back to global",
              `got ${JSON.stringify(fallbackEta.eta_samples)}`,
            )
          }
        }
      }
    }

    if (anon) {
      const { error: anonError } = await anon.rpc("dashboard_counts", {
        p_campaign_id: undefined,
        p_include_archived: false,
      })
      if (anonError) {
        pass("dashboard_counts not executable by anon")
      } else {
        fail("dashboard_counts not executable by anon", "RPC succeeded")
      }
    } else {
      skip(
        "dashboard_counts not executable by anon",
        "set NEXT_PUBLIC_SUPABASE_ANON_KEY to assert",
      )
    }

    if (await probeServer()) {
      const login = await loginSessionCookie(env.APP_PASSWORD)
      if ("reason" in login) {
        fail("sse latency", login.reason)
        fail("polling fallback endpoint", login.reason)
        fail("stream reconnect", login.reason)
      } else {
        const sessionCookie = login.cookie
        const queuedId = campaignLeadIds[statuses.indexOf("queued")]
        const streamUrl = `${BASE_URL}/api/stream/dashboard?campaign=${campaignId}`
        const latencyController = new AbortController()
        // Set once the stream is live and drained — the criterion measures
        // DB write → pushed frame, not connection setup.
        let latencyStart = performance.now()

        const streamResponse = await fetch(streamUrl, {
          signal: latencyController.signal,
          headers: {
            Cookie: `${SESSION_COOKIE_NAME}=${sessionCookie}`,
          },
        })

        if (!streamResponse.ok || !streamResponse.body) {
          fail("sse latency", `stream status ${streamResponse.status}`)
          fail("polling fallback endpoint", "stream unavailable")
          fail("stream reconnect", "stream unavailable")
        } else {
          const reader = streamResponse.body.getReader()
          const decoder = new TextDecoder()
          const initialFrame = await readSnapshotEvent(reader, decoder)

          if (!initialFrame) {
            fail("sse latency", "no initial snapshot frame")
          } else {
            // The criterion is about a live dashboard's steady-state latency,
            // not the cold-connect path: the server-side Realtime channel joins
            // asynchronously after the first subscriber arrives. Let it settle
            // so the number below measures write → push, not channel join.
            // (A write during the join is still recovered — ensureChannel()
            // schedules a catch-up tick on SUBSCRIBED — just not this fast.)
            await new Promise((resolve) => setTimeout(resolve, 2_000))

            latencyStart = performance.now()
            await supabase
              .from("campaign_leads")
              .update({ status: "processing", current_step: "recording" })
              .eq("id", queuedId)

            let sawUpdate = false
            let updateBuffer = initialFrame.buffer
            const updateDeadline = performance.now() + 5_000

            while (!sawUpdate && performance.now() < updateDeadline) {
              const { events, remainder } = parseSseEvents(updateBuffer)
              updateBuffer = remainder

              for (const frame of events) {
                if (frame.event !== "snapshot") continue
                const snapshot = JSON.parse(frame.data) as {
                  tiles?: { processing?: number; queued?: number }
                  processing?: Array<{ id: string; current_step?: string }>
                }
                const processingRow = snapshot.processing?.find(
                  (row) => row.id === queuedId,
                )
                if (
                  (snapshot.tiles?.processing ?? 0) >= 2 ||
                  processingRow?.current_step === "recording"
                ) {
                  sawUpdate = true
                  break
                }
              }

              if (sawUpdate) break

              const { done, value } = await reader.read()
              if (done) break
              updateBuffer += decoder.decode(value, { stream: true })
            }

            latencyController.abort()

            const elapsedMs = performance.now() - latencyStart
            if (sawUpdate && elapsedMs < 1500) {
              pass("sse latency", `${Math.round(elapsedMs)}ms`)
            } else if (!sawUpdate) {
              fail("sse latency", "no Realtime-pushed snapshot frame")
            } else {
              fail("sse latency", `${Math.round(elapsedMs)}ms`)
            }
          }

          const pollUrl = `${BASE_URL}/api/stream/dashboard?once=1&campaign=${campaignId}`
          const pollResponse = await fetch(pollUrl, {
            headers: { Cookie: `${SESSION_COOKIE_NAME}=${sessionCookie}` },
          })
          if (pollResponse.ok) {
            pass("polling fallback endpoint")
          } else {
            fail("polling fallback endpoint", `status ${pollResponse.status}`)
          }

          const reconnectController = new AbortController()
          const reconnectOpen = await fetch(streamUrl, {
            signal: reconnectController.signal,
            headers: { Cookie: `${SESSION_COOKIE_NAME}=${sessionCookie}` },
          })

          if (!reconnectOpen.ok || !reconnectOpen.body) {
            fail("stream reconnect", `open status ${reconnectOpen.status}`)
          } else {
            reconnectController.abort()
            await new Promise((resolve) => setTimeout(resolve, 50))

            const onceAfterAbort = await fetch(pollUrl, {
              headers: { Cookie: `${SESSION_COOKIE_NAME}=${sessionCookie}` },
            })
            if (!onceAfterAbort.ok) {
              fail(
                "stream reconnect",
                `once=1 after abort returned ${onceAfterAbort.status}`,
              )
            } else {
              const freshResponse = await fetch(streamUrl, {
                headers: { Cookie: `${SESSION_COOKIE_NAME}=${sessionCookie}` },
              })
              if (!freshResponse.ok || !freshResponse.body) {
                fail("stream reconnect", `re-open status ${freshResponse.status}`)
              } else {
                const freshReader = freshResponse.body.getReader()
                const freshDecoder = new TextDecoder()
                const freshFrame = await readSnapshotEvent(freshReader, freshDecoder)
                freshReader.cancel().catch(() => undefined)

                if (freshFrame?.snapshot) {
                  pass("stream reconnect")
                } else {
                  fail("stream reconnect", "no snapshot after re-open")
                }
              }
            }
          }
        }
      }
    } else {
      skip("sse latency", "dev server not running")
      skip("polling fallback endpoint", "dev server not running")
      skip("stream reconnect", "dev server not running")
    }

    // Runs last and in-process: it kills the shared Realtime socket and bumps
    // `updated_at` on a fixture row, so every count assertion above must
    // already have been made. No dev server needed — the subject is this
    // process's own stream singleton.
    if (campaignLeadIds.length > 0) {
      await checkChannelLifecycle(
        supabase,
        { campaignId, includeArchived: false },
        campaignLeadIds[0],
      )
    } else {
      skip("realtime socket kill recovers", "no fixture lead to poke")
      skip("channel teardown does not recurse", "no fixture lead to poke")
      skip("channel rebuilt after teardown", "no fixture lead to poke")
    }
  } finally {
    if (campaignId) {
      await supabase.from("campaigns").delete().eq("id", campaignId)
    }
    for (const extraId of extraCampaignIds) {
      await supabase.from("campaigns").delete().eq("id", extraId)
    }
    for (const leadId of leadIds) {
      await supabase.from("leads").delete().eq("id", leadId)
    }
  }

  const passed = results.filter((result) => result.state === "pass").length
  const skipped = results.filter((result) => result.state === "skip").length
  const failed = results.filter((result) => result.state === "fail").length
  const asserted = results.length - skipped
  console.log(
    `\n${passed}/${asserted} checks passed${skipped > 0 ? `, ${skipped} skipped` : ""}`,
  )
  if (failed > 0) {
    process.exitCode = 1
  }

  await closeQueueConnections()
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
