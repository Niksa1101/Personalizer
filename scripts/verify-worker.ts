/**
 * Worker and queue verification (Phase 7).
 * Spawns its own worker children — stop any manual `npm run worker` first.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { createClient } from "@supabase/supabase-js"

import type { Database } from "../lib/database.types"
import { assertEnvOrExit } from "../lib/env-node"
import type { PreviewResult } from "../lib/import-types"
import { setIntroCampaigns } from "../lib/intros"
import {
  assertRedisConnected,
  closeQueueConnections,
  scanLiveWorkers,
} from "../lib/queue"

const MINIMAL_TEMPLATE =
  "<!doctype html><html><body><h1>{{company}}</h1></body></html>"

const BASE_URL = "http://127.0.0.1:3000"
const ROOT = path.resolve(import.meta.dirname, "..")
const CONSUMING_TIMEOUT_MS = 30_000

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

async function login(): Promise<string | null> {
  const password = process.env.APP_PASSWORD?.trim()
  if (!password) {
    console.error("APP_PASSWORD is not set.")
    process.exit(1)
  }

  const response = await fetch(`${BASE_URL}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  })

  return parseCookies(getSetCookie(response)).get("pz_session") ?? null
}

function buildCsv(rows: Array<[string, string, string]>): string {
  const header = "company,website,email"
  const lines = rows.map(
    ([company, website, email]) => `${company},${website},${email}`,
  )
  return [header, ...lines].join("\n")
}

function spawnWorker(extraEnv: Record<string, string>): {
  child: ChildProcess
  consuming: Promise<void>
} {
  const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm"
  const child = spawn(npmCmd, ["run", "worker"], {
    cwd: ROOT,
    env: { ...process.env, PZ_ALLOW_MULTIPLE_WORKERS: "1", ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
  })

  const consuming = new Promise<void>((resolve, reject) => {
    let settled = false
    let buffer = ""

    const settle = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
    }

    const timer = setTimeout(() => {
      settle(() =>
        reject(
          new Error(
            `worker did not emit [worker] consuming within ${CONSUMING_TIMEOUT_MS}ms`,
          ),
        ),
      )
    }, CONSUMING_TIMEOUT_MS)

    const onData = (buf: Buffer) => {
      const text = buf.toString("utf8")
      process.stdout.write(text)
      buffer += text
      if (buffer.includes("[worker] consuming")) {
        child.stdout?.off("data", onData)
        settle(() => resolve())
      }
    }

    child.stdout?.on("data", onData)
    child.stderr?.on("data", (buf: Buffer) => {
      process.stderr.write(buf.toString("utf8"))
    })

    child.once("exit", (code) => {
      settle(() =>
        reject(new Error(`worker exited before consuming (code=${code})`)),
      )
    })
  })

  return { child, consuming }
}

function killWorkerTree(child: ChildProcess): void {
  if (!child.pid) return
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/T", "/F", "/PID", String(child.pid)], {
      stdio: "ignore",
    })
  } else {
    child.kill("SIGKILL")
  }
}

async function waitForWorkerStop(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode != null) return

  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs)
    child.once("exit", () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForLeadStatuses(
  supabase: ReturnType<typeof createClient<Database>>,
  campaignId: string,
  expected: Database["public"]["Enums"]["lead_status"],
  timeoutMs: number,
): Promise<{ ok: boolean; detail: string }> {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    const { data, error } = await supabase
      .from("campaign_leads")
      .select("id, status")
      .eq("campaign_id", campaignId)

    if (error) return { ok: false, detail: error.message }
    if ((data?.length ?? 0) === 0) {
      await sleep(250)
      continue
    }

    const allMatch = data!.every((row) => row.status === expected)
    if (allMatch) {
      return { ok: true, detail: `${data!.length} leads at ${expected}` }
    }

    await sleep(500)
  }

  const { data } = await supabase
    .from("campaign_leads")
    .select("status")
    .eq("campaign_id", campaignId)

  const counts = new Map<string, number>()
  for (const row of data ?? []) {
    counts.set(row.status, (counts.get(row.status) ?? 0) + 1)
  }

  return {
    ok: false,
    detail: `timeout — statuses: ${[...counts.entries()].map(([k, v]) => `${k}=${v}`).join(", ")}`,
  }
}

async function main(): Promise<void> {
  let liveWorkers: string[] = []
  try {
    liveWorkers = await scanLiveWorkers()
  } catch {
    liveWorkers = []
  }

  if (liveWorkers.length > 0) {
    console.error(
      "A worker is already running. Stop `npm run worker` first, then rerun verify:worker.",
    )
    process.exit(1)
  }

  if (!(await probeServer())) {
    console.error(
      `Dev server not reachable at ${BASE_URL}. Start \`npm run dev\` first.`,
    )
    process.exit(1)
  }

  try {
    await assertRedisConnected()
  } catch {
    console.error(
      "Redis is not reachable. Start it with:\n" +
        "  docker run -d --name pz-redis --restart unless-stopped -p 6379:6379 redis:7-alpine",
    )
    process.exit(1)
  }

  const sessionCookie = await login()
  if (!sessionCookie) {
    fail("session login", "no pz_session cookie")
    process.exit(1)
  }
  pass("session login")

  const env = assertEnvOrExit()
  const supabase = createClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } },
  )

  const runId = Date.now().toString(36)
  const tempDir = mkdtempSync(path.join(tmpdir(), "verify-worker-"))
  const cookieHeader = `pz_session=${sessionCookie}`

  const campaignIds: string[] = []
  const introIds: string[] = []
  const workers: ChildProcess[] = []

  async function createCampaign(name: string, slug: string): Promise<string> {
    const { data, error } = await supabase
      .from("campaigns")
      .insert({
        name,
        slug,
        landing_template: MINIMAL_TEMPLATE,
        merge_layout: "bubble_br",
        pip_scale: 0.2,
        viewport_width: 1920,
        viewport_height: 1080,
        nav_timeout_ms: 120_000,
      })
      .select("id")
      .single()

    if (error || !data) throw new Error(error?.message ?? "campaign insert failed")
    campaignIds.push(data.id)
    return data.id
  }

  async function insertIntro(): Promise<string> {
    const { data, error } = await supabase
      .from("intro_videos")
      .insert({
        name: `verify-intro-${runId}-${introIds.length}`,
        local_path: `intros/verify-${runId}-${introIds.length}.mp4`,
        duration_ms: 5000,
        width: 1280,
        height: 720,
        fps: 30,
      })
      .select("id")
      .single()

    if (error || !data) throw new Error(error?.message ?? "intro insert failed")
    introIds.push(data.id)
    return data.id
  }

  async function assignIntro(campaignId: string, introId: string): Promise<void> {
    const { error } = await supabase
      .from("campaigns")
      .update({ intro_video_id: introId })
      .eq("id", campaignId)

    if (error) throw new Error(error.message)
  }

  async function uploadPreview(
    campaignId: string,
    filePath: string,
    filename: string,
  ): Promise<PreviewResult & { error?: string }> {
    const form = new FormData()
    form.append("campaignId", campaignId)
    form.append(
      "file",
      new Blob([readFileSync(filePath)], { type: "text/csv" }),
      filename,
    )

    const response = await fetch(`${BASE_URL}/api/import`, {
      method: "POST",
      headers: { Cookie: cookieHeader },
      body: form,
    })

    return (await response.json()) as PreviewResult & { error?: string }
  }

  async function commitImport(
    preview: PreviewResult,
    campaignId: string,
    filename: string,
  ): Promise<{ batchId?: string; error?: string }> {
    const response = await fetch(`${BASE_URL}/api/import`, {
      method: "POST",
      headers: {
        Cookie: cookieHeader,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        token: preview.token,
        campaignId,
        filename,
        mapping: preview.mapping,
      }),
    })

    return (await response.json()) as { batchId?: string; error?: string }
  }

  async function importLeads(
    campaignId: string,
    rows: Array<[string, string, string]>,
    filename: string,
  ): Promise<void> {
    const csvPath = path.join(tempDir, filename)
    writeFileSync(csvPath, buildCsv(rows), "utf8")
    const preview = await uploadPreview(campaignId, csvPath, filename)
    if (!preview.token) throw new Error(preview.error ?? "preview failed")
    const commit = await commitImport(preview, campaignId, filename)
    if (!commit.batchId) throw new Error(commit.error ?? "commit failed")
  }

  try {
    // Leg 1 — happy path
    const introId = await insertIntro()
    const happyCampaignId = await createCampaign(
      `Verify Happy ${runId}`,
      `verify-happy-${runId}`,
    )
    await assignIntro(happyCampaignId, introId)

    const happyRows: Array<[string, string, string]> = Array.from(
      { length: 20 },
      (_, i) => [
        `Happy Co ${i}`,
        `https://happy-${runId}-${i}.example.com`,
        "",
      ],
    )
    await importLeads(happyCampaignId, happyRows, "happy.csv")

    const happySpawn = spawnWorker({ PIPELINE_STUB_STEP_MS: "50" })
    workers.push(happySpawn.child)
    await happySpawn.consuming

    // 120s: record-first doubles the recording stub, and each lead is many
    // remote Supabase round-trips under concurrency=1.
    const happyWait = await waitForLeadStatuses(
      supabase,
      happyCampaignId,
      "deployed",
      120_000,
    )
    if (!happyWait.ok) {
      fail("leg 1 — all deployed", happyWait.detail)
    } else {
      const { data: urls } = await supabase
        .from("campaign_leads")
        .select("netlify_url")
        .eq("campaign_id", happyCampaignId)

      const bad = (urls ?? []).filter(
        (row) => !row.netlify_url?.startsWith("https://stub.invalid/"),
      )
      if (bad.length > 0) {
        fail("leg 1 — stub URLs", `${bad.length} leads missing stub.invalid URL`)
      } else {
        pass("leg 1 — happy path", happyWait.detail)
      }
    }

    killWorkerTree(happySpawn.child)
    await waitForWorkerStop(happySpawn.child, 5000)

    // Leg 2 — pause / resume via setIntroCampaigns (real Phase 5 wiring)
    const pauseCampaignId = await createCampaign(
      `Verify Pause ${runId}`,
      `verify-pause-${runId}`,
    )
    const pauseRows: Array<[string, string, string]> = Array.from(
      { length: 3 },
      (_, i) => [
        `Pause Co ${i}`,
        `https://pause-${runId}-${i}.example.com`,
        "",
      ],
    )
    await importLeads(pauseCampaignId, pauseRows, "pause.csv")

    const pauseSpawn = spawnWorker({ PIPELINE_STUB_STEP_MS: "50" })
    workers.push(pauseSpawn.child)
    await pauseSpawn.consuming

    const pauseWait = await waitForLeadStatuses(
      supabase,
      pauseCampaignId,
      "paused",
      30_000,
    )
    if (!pauseWait.ok) {
      fail("leg 2 — paused at merge", pauseWait.detail)
    } else {
      const { data: pausedLeads } = await supabase
        .from("campaign_leads")
        .select("current_step, error_code")
        .eq("campaign_id", pauseCampaignId)

      const wrong = (pausedLeads ?? []).filter(
        (row) =>
          row.current_step !== "merge" || row.error_code !== "intro_missing",
      )
      if (wrong.length > 0) {
        fail("leg 2 — pause shape", "not all at merge/intro_missing")
      } else {
        pass("leg 2 — paused at merge")
      }
    }

    killWorkerTree(pauseSpawn.child)
    await waitForWorkerStop(pauseSpawn.child, 5000)

    // Second intro row — setIntroCampaigns deselects every non-selected campaign
    // from this intro, so reusing leg 1's intro would clear the happy campaign.
    const intro2Id = await insertIntro()
    await setIntroCampaigns(intro2Id, [pauseCampaignId])

    const resumeSpawn = spawnWorker({ PIPELINE_STUB_STEP_MS: "50" })
    workers.push(resumeSpawn.child)
    await resumeSpawn.consuming

    const resumeWait = await waitForLeadStatuses(
      supabase,
      pauseCampaignId,
      "deployed",
      30_000,
    )
    if (!resumeWait.ok) {
      fail("leg 2 — resume to deployed", resumeWait.detail)
    } else {
      pass("leg 2 — intro assignment resumes", resumeWait.detail)
    }

    killWorkerTree(resumeSpawn.child)
    await waitForWorkerStop(resumeSpawn.child, 5000)

    // Leg 3 — AC-7 interruption
    const ac7CampaignId = await createCampaign(
      `Verify AC7 ${runId}`,
      `verify-ac7-${runId}`,
    )
    await assignIntro(ac7CampaignId, introId)

    const ac7Rows: Array<[string, string, string]> = Array.from(
      { length: 4 },
      (_, i) => [`AC7 Co ${i}`, `https://ac7-${runId}-${i}.example.com`, ""],
    )
    await importLeads(ac7CampaignId, ac7Rows, "ac7.csv")

    const ac7Spawn = spawnWorker({ PIPELINE_STUB_STEP_MS: "1000" })
    workers.push(ac7Spawn.child)
    await ac7Spawn.consuming

    // Kill once at least one lead has been observed at status=processing.
    const observedProcessing = new Set<string>()
    const observeDeadline = Date.now() + 30_000
    while (Date.now() < observeDeadline && observedProcessing.size === 0) {
      const { data } = await supabase
        .from("campaign_leads")
        .select("id, status")
        .eq("campaign_id", ac7CampaignId)

      for (const row of data ?? []) {
        if (row.status === "processing") observedProcessing.add(row.id)
      }
      if (observedProcessing.size === 0) await sleep(250)
    }

    if (observedProcessing.size === 0) {
      fail("leg 3 — observed processing", "no lead reached processing before kill")
    } else {
      killWorkerTree(ac7Spawn.child)
      await waitForWorkerStop(ac7Spawn.child, 5000)

      // Past the 15s liveness TTL so the restart's boot reconcile sees the
      // hard-killed worker's Redis key gone (active jobs need the cross-check).
      await sleep(16_000)

      const ac7Restart = spawnWorker({ PIPELINE_STUB_STEP_MS: "50" })
      workers.push(ac7Restart.child)
      await ac7Restart.consuming

      const ac7Wait = await waitForLeadStatuses(
        supabase,
        ac7CampaignId,
        "deployed",
        120_000,
      )

      let interruptedOk = true
      for (const leadId of observedProcessing) {
        const { count } = await supabase
          .from("pipeline_events")
          .select("id", { count: "exact", head: true })
          .eq("campaign_lead_id", leadId)
          .eq("kind", "interrupted")

        if ((count ?? 0) < 1) interruptedOk = false
      }

      if (!ac7Wait.ok) {
        fail("leg 3 — recovery to deployed", ac7Wait.detail)
      } else if (!interruptedOk) {
        fail(
          "leg 3 — interrupted events",
          `missing on one or more of ${observedProcessing.size} observed lead(s)`,
        )
      } else {
        pass(
          "leg 3 — AC-7 interruption recovery",
          `interrupted on ${observedProcessing.size} lead(s)`,
        )
      }

      killWorkerTree(ac7Restart.child)
      await waitForWorkerStop(ac7Restart.child, 5000)
    }

    // Leg 4 — retry rules
    const retryCampaignId = await createCampaign(
      `Verify Retry ${runId}`,
      `verify-retry-${runId}`,
    )
    await assignIntro(retryCampaignId, introId)

    const retryRows: Array<[string, string, string]> = [
      ["DNS Fail Co", "https://fail-dns_failure.test", ""],
      ["Nav Timeout Co", "https://fail-nav_timeout.test", ""],
    ]
    await importLeads(retryCampaignId, retryRows, "retry.csv")

    const retrySpawn = spawnWorker({
      PIPELINE_STUB_STEP_MS: "50",
      PIPELINE_RETRY_BASE_MS: "200",
    })
    workers.push(retrySpawn.child)
    await retrySpawn.consuming

    const retryDeadline = Date.now() + 60_000
    let dnsFailed = false
    let navFailed = false

    while (Date.now() < retryDeadline && (!dnsFailed || !navFailed)) {
      const { data: leads } = await supabase
        .from("campaign_leads")
        .select("id, status, lead_id")
        .eq("campaign_id", retryCampaignId)

      for (const row of leads ?? []) {
        const { data: lead } = await supabase
          .from("leads")
          .select("website_url, domain")
          .eq("id", row.lead_id)
          .maybeSingle()

        const url = lead?.website_url ?? ""
        if (url.includes("dns_failure") && row.status === "failed") dnsFailed = true
        if (url.includes("nav_timeout") && row.status === "failed") navFailed = true
      }

      if (dnsFailed && navFailed) break
      await sleep(500)
    }

    const { data: retryLeadRows } = await supabase
      .from("campaign_leads")
      .select("id, lead_id")
      .eq("campaign_id", retryCampaignId)

    let dnsLeadId: string | null = null
    let navLeadId: string | null = null

    for (const row of retryLeadRows ?? []) {
      const { data: lead } = await supabase
        .from("leads")
        .select("website_url")
        .eq("id", row.lead_id)
        .maybeSingle()

      const url = lead?.website_url ?? ""
      if (url.includes("dns_failure")) dnsLeadId = row.id
      if (url.includes("nav_timeout")) navLeadId = row.id
    }

    const { count: dnsRuns } = await supabase
      .from("job_runs")
      .select("id", { count: "exact", head: true })
      .eq("campaign_lead_id", dnsLeadId ?? "")
      .eq("step", "recording")

    const { count: navRuns } = await supabase
      .from("job_runs")
      .select("id", { count: "exact", head: true })
      .eq("campaign_lead_id", navLeadId ?? "")
      .eq("step", "recording")

    const { data: autoRetrySetting } = await supabase
      .from("settings")
      .select("value")
      .eq("key", "queue.auto_retry_limit")
      .maybeSingle()

    const retryLimit =
      typeof autoRetrySetting?.value === "number"
        ? autoRetrySetting.value
        : 2

    if (!dnsFailed || !navFailed) {
      fail("leg 4 — failures reached", `dns=${dnsFailed} nav=${navFailed}`)
    } else if ((dnsRuns ?? 0) !== 1) {
      fail("leg 4 — dns_failure runs", `expected 1, got ${dnsRuns ?? 0}`)
    } else if ((navRuns ?? 0) !== retryLimit + 1) {
      fail(
        "leg 4 — nav_timeout runs",
        `expected ${retryLimit + 1}, got ${navRuns ?? 0}`,
      )
    } else {
      pass("leg 4 — retry bucket rules")
    }

    killWorkerTree(retrySpawn.child)
    await waitForWorkerStop(retrySpawn.child, 5000)
  } catch (error) {
    fail(
      "verify:worker",
      error instanceof Error ? error.message : String(error),
    )
  } finally {
    for (const child of workers) {
      killWorkerTree(child)
    }

    for (const id of campaignIds) {
      await supabase.from("campaigns").delete().eq("id", id)
    }

    for (const id of introIds) {
      await supabase.from("intro_videos").delete().eq("id", id)
    }

    rmSync(tempDir, { recursive: true, force: true })

    // assertRedisConnected/scanLiveWorkers open the shared ioredis client, and
    // an open client keeps Node's event loop alive indefinitely. Without this
    // the script prints its verdict and then hangs forever with all work done —
    // in CI, a job that runs to the runner timeout instead of reporting green.
    // worker/index.ts closes the same way on shutdown.
    //
    // Best-effort: this runs in a finally, and quit() can reject if the
    // connection already dropped. Throwing here would take the verdict below
    // down with it — the same "result never reaches the operator" failure the
    // close is here to fix.
    try {
      await closeQueueConnections()
    } catch (error) {
      console.warn(
        `Failed to close queue connections: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
  }

  const failed = results.filter((r) => !r.ok)
  if (failed.length > 0) {
    console.error(`\n${failed.length} check(s) failed.`)
    process.exit(1)
  }

  console.log(`\nAll ${results.length} checks passed.`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
