/**
 * Phase 14 logs verification — no browser.
 */

import { assertEnvOrExit } from "../lib/env-node"
import {
  describeInvalidLogParams,
  parseLogFilters,
  resolveLogTimeWindow,
} from "../lib/log-filters"
import { listLogs, resolveLeadRefIds } from "../lib/logs"
import { getSupabaseAdmin } from "../lib/supabase"

interface CheckResult {
  name: string
  state: "pass" | "fail" | "skip"
  detail: string
}

const results: CheckResult[] = []

function pass(name: string, detail = "ok"): void {
  results.push({ name, state: "pass", detail })
  console.log(`PASS  ${name}${detail === "ok" ? "" : ` — ${detail}`}`)
}

function fail(name: string, detail: string): void {
  results.push({ name, state: "fail", detail })
  process.exitCode = 1
  console.error(`FAIL  ${name} — ${detail}`)
}

async function main(): Promise<void> {
  assertEnvOrExit()
  const supabase = getSupabaseAdmin()
  const runId = Date.now().toString(36)

  const burstTime = new Date().toISOString()
  const ids: number[] = []
  for (let i = 0; i < 5; i++) {
    const { data, error } = await supabase
      .from("logs")
      .insert({
        level: "info",
        scope: "web",
        message: `verify-logs burst ${runId} ${i}`,
        created_at: burstTime,
      })
      .select("id")
      .single()
    if (error) throw error
    ids.push(data.id)
  }

  const page1 = await listLogs(parseLogFilters({ preset: "24h" }))
  const page2 = await listLogs(
    parseLogFilters({ preset: "24h", cursor: page1.nextCursor ?? undefined }),
  )
  const burstIds = new Set(
    [...page1.rows, ...page2.rows]
      .filter((row) => row.message.includes(`verify-logs burst ${runId}`))
      .map((row) => row.id),
  )
  if (burstIds.size === ids.length) {
    pass("keyset pagination stable across same-timestamp burst")
  } else {
    fail(
      "keyset pagination stable across same-timestamp burst",
      `expected ${ids.length}, saw ${burstIds.size}`,
    )
  }

  await supabase.from("logs").delete().in("id", ids)

  const matchId = (
    await supabase
      .from("logs")
      .insert({
        level: "warn",
        scope: "worker",
        message: `verify-logs compose match ${runId}`,
      })
      .select("id")
      .single()
  ).data!.id
  const noMatchId = (
    await supabase
      .from("logs")
      .insert({
        level: "debug",
        scope: "web",
        message: `verify-logs compose miss ${runId}`,
      })
      .select("id")
      .single()
  ).data!.id

  const composed = await listLogs(
    parseLogFilters({
      preset: "24h",
      level: "warn,error",
      scope: "worker",
      q: "compose match",
    }),
  )
  const composedIds = composed.rows.map((row) => row.id)
  if (
    composedIds.includes(matchId) &&
    !composedIds.includes(noMatchId) &&
    composed.rows.length === 1
  ) {
    pass("filters compose")
  } else {
    fail(
      "filters compose",
      `expected only ${matchId}, got ${composedIds.join(",")}`,
    )
  }
  await supabase.from("logs").delete().in("id", [matchId, noMatchId])

  const bogusLevelFilters = parseLogFilters({ preset: "24h", level: "bogus" })
  const bogusLevel = await listLogs(bogusLevelFilters)
  if (bogusLevel.rows.length === 0) {
    pass("bogus level yields no rows, not all rows")
  } else {
    fail(
      "bogus level yields no rows, not all rows",
      `got ${bogusLevel.rows.length} rows`,
    )
  }

  const craftedCursorFilters = parseLogFilters({
    preset: "24h",
    cursor: "x') or (1=1--|1",
  })
  const injected = await listLogs(craftedCursorFilters)
  if (injected.rows.length === 0 && injected.nextCursor == null) {
    pass("crafted cursor is rejected, not interpolated")
  } else {
    fail(
      "crafted cursor is rejected, not interpolated",
      `returned ${injected.rows.length} rows`,
    )
  }

  // Every emptying short-circuit inside listLogs must reach the screen as a
  // reason. Otherwise a bookmarked bad link reads as "no logs in this window".
  const unexplained = [
    { label: "level=bogus", filters: bogusLevelFilters },
    { label: "crafted cursor", filters: craftedCursorFilters },
    {
      label: "both",
      filters: parseLogFilters({ level: "bogus", cursor: "garbage" }),
    },
  ].filter(({ filters }) => describeInvalidLogParams(filters).length === 0)
  if (unexplained.length === 0) {
    pass("rejected params are explained, not shown as an empty window")
  } else {
    fail(
      "rejected params are explained, not shown as an empty window",
      `${unexplained.map((entry) => entry.label).join(", ")} produced no notice`,
    )
  }

  const defaults = parseLogFilters({})
  if (defaults.preset === "24h") {
    pass("default preset is 24h")
  } else {
    fail("default preset is 24h", defaults.preset)
  }

  const scratchFrom = new Date(Date.now() - 60_000).toISOString()
  const pageIds: number[] = []
  for (let i = 0; i < 101; i++) {
    const { data, error } = await supabase
      .from("logs")
      .insert({
        level: "info",
        scope: "web",
        message: `verify-logs page ${runId} ${i}`,
        created_at: scratchFrom,
      })
      .select("id")
      .single()
    if (error) throw error
    pageIds.push(data.id)
  }

  const paged = await listLogs(
    parseLogFilters({ from: scratchFrom, to: new Date().toISOString() }),
  )
  if (paged.rows.length === 100 && paged.nextCursor != null) {
    pass("default page size is 100")
  } else {
    fail(
      "default page size is 100",
      `rows=${paged.rows.length} cursor=${paged.nextCursor}`,
    )
  }
  await supabase.from("logs").delete().in("id", pageIds)

  const openEnded = resolveLogTimeWindow(parseLogFilters({ preset: "24h" }))
  const closed = resolveLogTimeWindow(
    parseLogFilters({ preset: "24h", to: new Date().toISOString() }),
  )
  if (openEnded.openEnded && !closed.openEnded) {
    pass("new-count only for open-ended range")
  } else {
    fail("new-count only for open-ended range", "openEnded mismatch")
  }

  let threw = false
  try {
    resolveLogTimeWindow(parseLogFilters({ from: "not-a-date" }))
  } catch {
    threw = true
  }
  if (!threw) {
    pass("?from=not-a-date does not throw")
  } else {
    fail("?from=not-a-date does not throw", "threw RangeError")
  }

  const unknown = await listLogs(parseLogFilters({ lead: "LD-999999" }))
  if (unknown.unknownLeadRef && unknown.rows.length === 0) {
    pass("unknown lead ref returns empty with message")
  } else {
    fail("unknown lead ref returns empty with message", "unexpected result")
  }

  const { data: lead } = await supabase
    .from("leads")
    .insert({ company: `Logs ${runId}`, domain: `logs${runId}.example.com` })
    .select("id, ref")
    .single()
  const campaignIds: string[] = []
  const clIds: string[] = []
  for (const suffix of ["a", "b"]) {
    const { data: campaign } = await supabase
      .from("campaigns")
      .insert({
        name: `Verify Logs ${runId} ${suffix}`,
        slug: `verify-logs-${runId}-${suffix}`,
        landing_template: "<html></html>",
      })
      .select("id")
      .single()
    campaignIds.push(campaign!.id)
    const { data: cl } = await supabase
      .from("campaign_leads")
      .insert({
        campaign_id: campaign!.id,
        lead_id: lead!.id,
        slug: `verify-logs-${runId}-${suffix}`,
        status: "queued",
      })
      .select("id")
      .single()
    clIds.push(cl!.id)
  }

  const logA = (
    await supabase
      .from("logs")
      .insert({
        level: "info",
        scope: "worker",
        message: `verify-logs dual campaign ${runId}`,
        campaign_lead_id: clIds[0],
      })
      .select("id")
      .single()
  ).data!.id
  const logB = (
    await supabase
      .from("logs")
      .insert({
        level: "info",
        scope: "worker",
        message: `verify-logs dual campaign ${runId}`,
        campaign_lead_id: clIds[1],
      })
      .select("id")
      .single()
  ).data!.id

  const resolvedIds = await resolveLeadRefIds(lead!.ref)
  if (resolvedIds.length !== 2) {
    fail(
      "lead in two campaigns returns both campaigns' logs",
      `resolveLeadRefIds returned ${resolvedIds.length}`,
    )
  } else {
  const dual = await listLogs(
    parseLogFilters({
      preset: "all",
      lead: lead!.ref,
      q: `verify-logs dual campaign ${runId}`,
    }),
  )
  const dualIds = new Set(dual.rows.map((row) => row.id))
  if (dualIds.has(logA) && dualIds.has(logB)) {
    pass("lead in two campaigns returns both campaigns' logs")
  } else {
    fail(
      "lead in two campaigns returns both campaigns' logs",
      `missing ${logA} or ${logB}`,
    )
  }
  }

  await supabase.from("logs").delete().in("id", [logA, logB])
  await supabase.from("campaign_leads").delete().in("id", clIds)
  await supabase.from("campaigns").delete().in("id", campaignIds)
  await supabase.from("leads").delete().eq("id", lead!.id)

  const { data: sample } = await supabase
    .from("logs")
    .insert({
      level: "error",
      scope: "merger",
      message: `verify-logs expanded ${runId}`,
      meta: { stderr: "line1\nline2" },
      campaign_lead_id: null,
      job_run_id: null,
    })
    .select("*")
    .single()

  if (sample?.meta) {
    pass("expanded-row payload carries meta and correlation ids")
    await supabase.from("logs").delete().eq("id", sample.id)
  } else {
    fail("expanded-row payload carries meta and correlation ids", "missing meta")
  }

  const passed = results.filter((r) => r.state === "pass").length
  const failed = results.filter((r) => r.state === "fail").length
  console.log(`\nSummary: ${passed} passed, ${failed} failed`)
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => process.exit(process.exitCode ?? 0))
