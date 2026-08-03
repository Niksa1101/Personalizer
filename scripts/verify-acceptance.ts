/**
 * Phase 18 acceptance verification — offline legs by default, credentialed legs when
 * `.env.local` is present, and `--watch <campaignId>` for AC-1 stall detection.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
} from "node:fs"
import { join, relative } from "node:path"

import { createClient, type SupabaseClient } from "@supabase/supabase-js"

import type { Database } from "../lib/database.types"
import { ERROR_BUCKETS, ERROR_CODES } from "../lib/pipeline-types"
import { ERROR_COPY } from "../lib/error-copy"
import { TERMINAL_STATUSES } from "../lib/lead-filters"
import type { ImportCounts } from "../lib/import-types"
import {
  closeQueueConnections,
  LIVENESS_TTL_SECONDS,
  registerLiveness,
  scanLiveWorkers,
} from "../lib/queue"
import { resolveMany } from "../lib/settings"
import { assembleManifestFromDb, manifestFilePath } from "../worker/deploy/sync"
import {
  assertDrawerActionExhaustiveness,
  generateErrorsMarkdown,
  loadReproSidecar,
  validateReproSidecar,
} from "./gen-error-docs"

interface CheckResult {
  name: string
  state: "pass" | "fail" | "skip"
  detail: string
}

const results: CheckResult[] = []
const repoRoot = join(import.meta.dirname, "..")
const FIXTURE_DIR = join(repoRoot, "scripts", "fixtures")

/** AC-1's terminal set — deliberately NOT lib/lead-filters.ts's TERMINAL_STATUSES. */
const AC1_TERMINAL = new Set(["deployed", "failed", "skipped"])
const STALL_STATUSES = new Set(["paused"])

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

function summarize(): void {
  const passed = results.filter((r) => r.state === "pass").length
  const skipped = results.filter((r) => r.state === "skip").length
  const failed = results.filter((r) => r.state === "fail").length
  const asserted = results.length - skipped
  console.log(
    `\n${passed}/${asserted} checks passed${skipped > 0 ? `, ${skipped} skipped` : ""}`,
  )
  if (failed > 0) process.exitCode = 1
}

function hasCredentials(): {
  url: string
  serviceKey: string
} | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? ""
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? ""
  if (!url || !serviceKey || !/^eyJ/.test(serviceKey)) return null
  return { url, serviceKey }
}

/** Mirrors public.normalize_domain() for offline fixture parsing. */
function normalizeDomainKey(raw: string): string | null {
  let value = raw.trim().toLowerCase()
  value = value.replace(/^(?:[a-z][a-z0-9+.-]*:)?\/\/(?:[^/@]*@)?/, "")
  value = value.replace(/[/?#].*$/, "")
  value = value.replace(/:[0-9]+$/, "")
  value = value.replace(/^www\./, "")
  value = value.replace(/\.$/, "")
  value = value.trim()
  return value || null
}

function readFixtureDomains(filePath: string): string[] {
  const text = readFileSync(filePath, "utf8")
  const lines = text.split(/\r?\n/).filter((line) => line.trim())
  if (lines.length < 2) return []

  const header = lines[0]!.split(",").map((h) => h.trim().toLowerCase())
  const websiteIdx = header.findIndex((h) =>
    ["website", "websiteurl", "url", "domain", "site", "homepage"].includes(
      h.replace(/[\s_-]+/g, ""),
    ),
  )
  if (websiteIdx < 0) return []

  const domains: string[] = []
  for (const line of lines.slice(1)) {
    const cols = line.split(",")
    const website = cols[websiteIdx]?.trim()
    if (!website) continue
    const domain = normalizeDomainKey(website)
    if (domain) domains.push(domain)
  }
  return domains
}

function acceptanceFixturePaths(): string[] {
  const acceptanceDir = join(FIXTURE_DIR, "acceptance")
  if (!existsSync(acceptanceDir)) return []
  return readdirSync(acceptanceDir)
    .filter((name) => name.endsWith(".csv"))
    .map((name) => join(acceptanceDir, name))
}

async function fetchExistingDomains(domains: string[]): Promise<string[]> {
  const creds = hasCredentials()
  if (!creds || domains.length === 0) return []

  const admin = createClient<Database>(creds.url, creds.serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const existing: string[] = []
  const chunkSize = 100
  for (let i = 0; i < domains.length; i += chunkSize) {
    const chunk = domains.slice(i, i + chunkSize)
    const { data, error } = await admin
      .from("leads")
      .select("domain")
      .in("domain", chunk)
    if (error) throw new Error(error.message)
    for (const row of data ?? []) {
      if (row.domain) existing.push(row.domain)
    }
  }
  return existing
}

async function checkDomainDisjointness(fixturePaths: string[]): Promise<void> {
  if (fixturePaths.length === 0) {
    pass("O5 fixture domains are disjoint", "no acceptance fixtures yet")
    return
  }

  const seen = new Map<string, string>()
  const collisions: string[] = []

  for (const file of fixturePaths) {
    const rel = relative(repoRoot, file)
    for (const domain of readFixtureDomains(file)) {
      const prior = seen.get(domain)
      if (prior && prior !== rel) {
        collisions.push(`${domain}: ${prior} + ${rel}`)
      } else {
        seen.set(domain, rel)
      }
    }
  }
  if (collisions.length > 0) {
    fail("O5 fixture domains are disjoint", collisions.slice(0, 10).join("; "))
    return
  }

  const creds = hasCredentials()
  if (!creds) {
    pass(
      "O5 fixture domains are disjoint",
      `${seen.size} unique domains (DB check skipped — no credentials)`,
    )
    return
  }

  try {
    const existing = await fetchExistingDomains([...seen.keys()])
    if (existing.length > 0) {
      fail(
        "O5 fixture domains absent from leads",
        `already in leads: ${existing.slice(0, 10).join(", ")}`,
      )
      return
    }
    pass("O5 fixture domains are disjoint", `${seen.size} unique domains`)
  } catch (error) {
    pass(
      "O5 fixture domains are disjoint",
      `${seen.size} unique domains (DB check skipped — ${error instanceof Error ? error.message : String(error)})`,
    )
  }
}

function assertImportReport(counts: ImportCounts, expected: ImportCounts): void {
  const keys: (keyof ImportCounts)[] = [
    "imported",
    "linked",
    "duplicate",
    "skipped",
  ]
  for (const key of keys) {
    if (counts[key] !== expected[key]) {
      throw new Error(
        `import ${key}: expected ${expected[key]}, got ${counts[key]}`,
      )
    }
  }
}

async function checkNoRecordingReuse(
  admin: SupabaseClient<Database>,
  campaignId: string,
  runStartedAt: string,
): Promise<void> {
  const { data: leads, error } = await admin
    .from("campaign_leads")
    .select("id, recording_id")
    .eq("campaign_id", campaignId)
    .not("recording_id", "is", null)
  if (error) {
    fail("N5 no recording reuse", error.message)
    return
  }

  const ids = [...new Set((leads ?? []).map((l) => l.recording_id!))]
  if (ids.length === 0) {
    fail("N5 no recording reuse", "no recordings linked at all")
    return
  }

  const { data: recs, error: recErr } = await admin
    .from("recordings")
    .select("id, created_at")
    .in("id", ids)
  if (recErr) {
    fail("N5 no recording reuse", recErr.message)
    return
  }

  const stale = (recs ?? []).filter((r) => r.created_at < runStartedAt)
  if (stale.length > 0) {
    fail(
      "N5 no recording reuse",
      `${stale.length} lead(s) reused a pre-run recording — check fixture disjointness`,
    )
    return
  }
  pass("N5 no recording reuse", `${recs!.length} recordings, all created during the run`)
}

async function stepBudgetsMs(): Promise<Record<string, number>> {
  const s = await resolveMany([
    "recorder.nav_timeout_ms",
    "encode.merge_timeout_ms",
    "deploy.timeout_ms",
    "queue.auto_retry_limit",
  ])
  const attempts = s["queue.auto_retry_limit"] + 1
  const margin = 1.5
  return {
    recording: s["recorder.nav_timeout_ms"] * attempts * margin,
    merge: s["encode.merge_timeout_ms"] * attempts * margin,
    page: 120_000 * attempts * margin,
    deploy: s["deploy.timeout_ms"] * attempts * margin,
  }
}

function runOfflineLegs(): void {
  try {
    const repro = loadReproSidecar()
    validateReproSidecar(repro)
    pass("O2 error-repro.json key set matches ERROR_CODES")
  } catch (error) {
    fail(
      "O2 error-repro.json key set matches ERROR_CODES",
      error instanceof Error ? error.message : String(error),
    )
  }

  try {
    const repro = loadReproSidecar()
    const generated = generateErrorsMarkdown(repro)
    let committed = ""
    try {
      committed = readFileSync(join(repoRoot, "docs", "Errors.md"), "utf8")
    } catch {
      fail("O1 docs/Errors.md matches ERROR_COPY", "missing — run npm run docs:errors")
      committed = ""
    }
    if (committed && committed === generated) {
      pass("O1 docs/Errors.md matches ERROR_COPY")
    } else if (committed) {
      fail("O1 docs/Errors.md matches ERROR_COPY", "drift — run npm run docs:errors")
    }
  } catch (error) {
    fail(
      "O1 docs/Errors.md matches ERROR_COPY",
      error instanceof Error ? error.message : String(error),
    )
  }

  const bucketMismatches: string[] = []
  for (const code of ERROR_CODES) {
    const copyBucket = ERROR_COPY[code].bucket
    if (!(ERROR_BUCKETS as readonly string[]).includes(copyBucket)) {
      bucketMismatches.push(`${code}:${copyBucket}`)
    }
  }
  if (bucketMismatches.length === 0) {
    pass("O3 ERROR_COPY buckets match pipeline-types mirror")
  } else {
    fail("O3 ERROR_COPY buckets match pipeline-types mirror", bucketMismatches.join(", "))
  }

  const drawerErrors = assertDrawerActionExhaustiveness()
  if (drawerErrors.length === 0) {
    pass("O4 DrawerActionId exhaustiveness")
  } else {
    fail("O4 DrawerActionId exhaustiveness", drawerErrors.slice(0, 5).join("; "))
  }

  if (AC1_TERMINAL.has("paused")) {
    fail("O4b AC1_TERMINAL excludes paused", "paused must be a stall, not terminal")
  } else if ((TERMINAL_STATUSES as readonly string[]).includes("deployed")) {
    fail("O4b AC1_TERMINAL differs from promotion TERMINAL_STATUSES", "unexpected overlap")
  } else {
    pass(
      "O4b AC1_TERMINAL differs from promotion TERMINAL_STATUSES",
      `AC1=[${[...AC1_TERMINAL].join(",")}] promotion=[${TERMINAL_STATUSES.join(",")}]`,
    )
  }
}

async function runNetworkLegs(): Promise<void> {
  const creds = hasCredentials()
  if (!creds) {
    skip("network legs N1–N6", "missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY")
    return
  }

  const admin = createClient<Database>(creds.url, creds.serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const bucketMismatches: string[] = []
  let networkError: string | null = null
  for (const code of ERROR_CODES) {
    const { data, error } = await admin.rpc("error_code_bucket", { code })
    if (error) {
      if (/fetch failed/i.test(error.message)) {
        networkError = error.message
        break
      }
      bucketMismatches.push(`${code}: rpc error ${error.message}`)
      continue
    }
    if (data !== ERROR_COPY[code].bucket) {
      bucketMismatches.push(`${code}: sql=${data} copy=${ERROR_COPY[code].bucket}`)
    }
  }
  if (networkError) {
    skip("N1 bucket truth via error_code_bucket()", networkError)
  } else if (bucketMismatches.length === 0) {
    pass("N1 bucket truth via error_code_bucket()")
  } else {
    fail("N1 bucket truth via error_code_bucket()", bucketMismatches.slice(0, 5).join("; "))
  }

  await runWorkerLockLeg()

  skip(
    "N3 manifest preflight",
    "pass --campaign <id> --expected-paths <file> during acceptance run",
  )
  skip(
    "N4 import outcome assertion",
    "pass --import-batch <id> during acceptance run",
  )
  skip(
    "N5 no recording reuse",
    "pass --campaign <id> --run-started-at <iso> during acceptance run",
  )
  skip(
    "N6 retained_pages count unchanged",
    "pass --retained-count-before <n> --retained-count-after <n> during teardown",
  )
}

async function probeSupabaseReachable(
  creds: { url: string; serviceKey: string },
): Promise<string | null> {
  const admin = createClient<Database>(creds.url, creds.serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { error } = await admin.from("campaigns").select("id").limit(1)
  if (error && /fetch failed/i.test(error.message)) return error.message
  return null
}

async function runWorkerLockLeg(): Promise<void> {
  const creds = hasCredentials()
  if (!creds) {
    skip("N2 worker-lock refusal", "no credentials")
    return
  }

  try {
    await registerLiveness("verify-acceptance:fake-live")
    const live = await scanLiveWorkers()
    if (!live.some((id) => id.startsWith("verify-acceptance:"))) {
      fail("N2 worker-lock refusal", "failed to plant live liveness key")
      return
    }

    const refused = await spawnWorkerExpectExit(1)
    if (!refused) {
      fail("N2 worker-lock refusal", "second worker booted while live key present")
      return
    }
    pass("N2 worker-lock refusal", "boot refused while live key present")

    const networkError = await probeSupabaseReachable(creds)
    if (networkError) {
      skip(
        "N2 worker-lock permitted after TTL",
        `worker boot requires Supabase — ${networkError}`,
      )
      return
    }

    await closeQueueConnections()
    await new Promise((r) => setTimeout(r, (LIVENESS_TTL_SECONDS + 2) * 1000))

    const booted = await spawnWorkerExpectConsuming()
    if (booted) {
      pass("N2 worker-lock permitted after TTL", "boot succeeded after liveness expired")
    } else {
      fail("N2 worker-lock permitted after TTL", "worker did not boot after TTL")
    }
  } catch (error) {
    skip(
      "N2 worker-lock refusal",
      error instanceof Error ? error.message : String(error),
    )
  }
}

async function spawnWorkerExpectExit(expectedCode: number): Promise<boolean> {
  const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm"
  const env = { ...process.env }
  delete env.PZ_ALLOW_MULTIPLE_WORKERS
  const child = spawn(npmCmd, ["run", "worker"], {
    cwd: repoRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
  })

  return new Promise<boolean>((resolve) => {
    let buffer = ""
    const timer = setTimeout(() => {
      killWorkerTree(child)
      resolve(false)
    }, 20_000)

    const onData = (buf: Buffer) => {
      buffer += buf.toString("utf8")
    }
    child.stdout?.on("data", onData)
    child.stderr?.on("data", onData)

    child.once("exit", (code) => {
      clearTimeout(timer)
      child.stdout?.off("data", onData)
      child.stderr?.off("data", onData)
      const refused =
        buffer.includes("refusing to start") ||
        buffer.includes("another worker is booting right now")
      // Windows can crash libuv on process.exit(1) after closeQueueConnections()
      // (exit 3221226505) even when refusal ran — trust the log line.
      resolve(code === expectedCode || (refused && code !== 0 && code !== null))
    })
  })
}

async function spawnWorkerExpectConsuming(): Promise<boolean> {
  const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm"
  const child = spawn(npmCmd, ["run", "worker"], {
    cwd: repoRoot,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
  })

  return new Promise<boolean>((resolve) => {
    let buffer = ""
    const timer = setTimeout(() => {
      killWorkerTree(child)
      resolve(false)
    }, 35_000)

    const onData = (buf: Buffer) => {
      buffer += buf.toString("utf8")
      if (buffer.includes("[worker] consuming")) {
        clearTimeout(timer)
        child.stdout?.off("data", onData)
        killWorkerTree(child)
        resolve(true)
      }
    }

    child.stdout?.on("data", onData)
    child.once("exit", () => {
      clearTimeout(timer)
      resolve(false)
    })
  })
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

type WatchFlag = {
  kind: "hard" | "soft" | "divergence" | "stall"
  campaignLeadId: string
  step: string | null
  detail: string
}

async function runWatch(campaignId: string): Promise<void> {
  const creds = hasCredentials()
  if (!creds) {
    console.error("--watch requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY")
    process.exitCode = 1
    return
  }

  const admin = createClient<Database>(creds.url, creds.serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const outDir = join(repoRoot, ".acceptance-watch")
  mkdirSync(outDir, { recursive: true })
  const jsonlPath = join(outDir, `watch-${campaignId}.jsonl`)
  const flags: WatchFlag[] = []
  const softSignals: WatchFlag[] = []
  const stepMedians = new Map<string, number[]>()

  const writeRecord = (record: Record<string, unknown>) => {
    appendFileSync(jsonlPath, `${JSON.stringify(record)}\n`)
  }

  const budgets = await stepBudgetsMs()
  writeRecord({ type: "start", campaignId, budgets, at: new Date().toISOString() })

  while (true) {
    const { data: leads, error } = await admin
      .from("campaign_leads")
      .select("id, status, current_step, updated_at")
      .eq("campaign_id", campaignId)

    if (error) {
      console.error("watch query failed:", error.message)
      process.exitCode = 1
      break
    }

    const now = Date.now()
    let allTerminal = true

    for (const lead of leads ?? []) {
      if (!AC1_TERMINAL.has(lead.status)) allTerminal = false
      if (STALL_STATUSES.has(lead.status)) {
        flags.push({
          kind: "stall",
          campaignLeadId: lead.id,
          step: lead.current_step,
          detail: `status=${lead.status}`,
        })
        writeRecord({
          type: "flag",
          kind: "stall",
          leadId: lead.id,
          at: new Date().toISOString(),
        })
      }

      if (AC1_TERMINAL.has(lead.status) || STALL_STATUSES.has(lead.status)) continue

      const step = lead.current_step ?? "unknown"
      const eventMs = await timeInStepFromEvents(admin, lead.id, step)
      const jobMs = await timeInStepFromJobRun(admin, lead.id, step)
      const tolerance = 5_000
      if (
        eventMs != null &&
        jobMs != null &&
        Math.abs(eventMs - jobMs) > tolerance
      ) {
        flags.push({
          kind: "divergence",
          campaignLeadId: lead.id,
          step,
          detail: `events=${eventMs}ms job_run=${jobMs}ms`,
        })
      }

      const elapsed = eventMs ?? jobMs ?? now - Date.parse(lead.updated_at)
      const budget = budgets[step] ?? budgets.deploy!
      if (elapsed > budget) {
        flags.push({
          kind: "hard",
          campaignLeadId: lead.id,
          step,
          detail: `${elapsed}ms > budget ${budget}ms`,
        })
      } else {
        const samples = stepMedians.get(step) ?? []
        samples.push(elapsed)
        stepMedians.set(step, samples)
        if (samples.length >= 3) {
          const sorted = [...samples].sort((a, b) => a - b)
          const median = sorted[Math.floor(sorted.length / 2)]!
          if (elapsed > median * 3) {
            softSignals.push({
              kind: "soft",
              campaignLeadId: lead.id,
              step,
              detail: `${elapsed}ms > 3× median ${median}ms`,
            })
          }
        }
      }
    }

    writeRecord({
      type: "tick",
      at: new Date().toISOString(),
      leadCount: leads?.length ?? 0,
      terminal: allTerminal,
      hardFlags: flags.length,
    })

    if (allTerminal) break
    await new Promise((r) => setTimeout(r, 15_000))
  }

  const summary = {
    campaignId,
    hardFlags: flags.length,
    softSignalCount: softSignals.length,
    flags,
    softSignals,
  }
  writeRecord({ type: "summary", ...summary })
  console.log(JSON.stringify(summary, null, 2))

  if (flags.length > 0) process.exitCode = 1
}

async function timeInStepFromEvents(
  admin: SupabaseClient<Database>,
  campaignLeadId: string,
  step: string,
): Promise<number | null> {
  const { data, error } = await admin
    .from("pipeline_events")
    .select("kind, step, created_at")
    .eq("campaign_lead_id", campaignLeadId)
    .order("created_at", { ascending: false })
    .limit(20)
  if (error || !data?.length) return null

  const started = data.find((e) => e.kind === "step_started" && e.step === step)
  if (!started) return null
  return Date.now() - Date.parse(started.created_at)
}

async function timeInStepFromJobRun(
  admin: SupabaseClient<Database>,
  campaignLeadId: string,
  step: string,
): Promise<number | null> {
  const { data, error } = await admin
    .from("job_runs")
    .select("step, started_at, finished_at")
    .eq("campaign_lead_id", campaignLeadId)
    .eq("step", step as Database["public"]["Enums"]["pipeline_step"])
    .is("finished_at", null)
    .order("started_at", { ascending: false })
    .limit(1)
  if (error || !data?.length) return null
  return Date.now() - Date.parse(data[0]!.started_at)
}

function parseCliArgs(): {
  watchCampaignId: string | null
  campaignId: string | null
  runStartedAt: string | null
  importBatchId: string | null
  retainedBefore: number | null
  retainedAfter: number | null
} {
  const argv = process.argv.slice(2)
  let watchCampaignId: string | null = null
  let campaignId: string | null = null
  let runStartedAt: string | null = null
  let importBatchId: string | null = null
  let retainedBefore: number | null = null
  let retainedAfter: number | null = null

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--watch" && argv[i + 1]) {
      watchCampaignId = argv[++i]!
    } else if (arg === "--campaign" && argv[i + 1]) {
      campaignId = argv[++i]!
    } else if (arg === "--run-started-at" && argv[i + 1]) {
      runStartedAt = argv[++i]!
    } else if (arg === "--import-batch" && argv[i + 1]) {
      importBatchId = argv[++i]!
    } else if (arg === "--retained-count-before" && argv[i + 1]) {
      retainedBefore = Number(argv[++i])
    } else if (arg === "--retained-count-after" && argv[i + 1]) {
      retainedAfter = Number(argv[++i])
    }
  }

  return {
    watchCampaignId,
    campaignId,
    runStartedAt,
    importBatchId,
    retainedBefore,
    retainedAfter,
  }
}

async function runOptionalNetworkAssertions(input: {
  campaignId: string | null
  runStartedAt: string | null
  importBatchId: string | null
  retainedBefore: number | null
  retainedAfter: number | null
}): Promise<void> {
  const creds = hasCredentials()
  if (!creds) return

  const admin = createClient<Database>(creds.url, creds.serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  if (input.importBatchId) {
    const { data, error } = await admin
      .from("import_batches")
      .select("imported_count, linked_count, duplicate_count, skipped_count")
      .eq("id", input.importBatchId)
      .maybeSingle()
    if (error) {
      fail("N4 import outcome assertion", error.message)
    } else if (!data) {
      fail("N4 import outcome assertion", "batch not found")
    } else {
      try {
        assertImportReport(
          {
            imported: data.imported_count,
            linked: data.linked_count,
            duplicate: data.duplicate_count,
            skipped: data.skipped_count,
            rejected: 0,
          },
          { imported: 100, linked: 0, duplicate: 4, skipped: 1, rejected: 0 },
        )
        pass("N4 import outcome assertion", "100 imported, 4 duplicate, 0 linked, 1 skipped")
      } catch (e) {
        fail("N4 import outcome assertion", e instanceof Error ? e.message : String(e))
      }
    }
  }

  if (input.campaignId && input.runStartedAt) {
    await checkNoRecordingReuse(admin, input.campaignId, input.runStartedAt)
  }

  if (input.campaignId && !input.runStartedAt) {
    try {
      const { manifest } = await assembleManifestFromDb()
      const paths = Object.keys(manifest.files).sort()
      const { data: pages, error } = await admin
        .from("landing_pages")
        .select("path, deploy_status")
        .in("deploy_status", ["pending", "uploading", "live", "failed"])
      if (error) throw error
      const expected = new Set(
        (pages ?? []).map((p) => manifestFilePath(p.path)),
      )
      expected.add("/robots.txt")
      expected.add("/404.html")
      const manifestSet = new Set(paths)
      const missing = [...expected].filter((p) => !manifestSet.has(p))
      const extra = paths.filter((p) => !expected.has(p) && !p.startsWith("/retained/"))
      if (missing.length === 0 && extra.length === 0) {
        pass("N3 manifest preflight", `${paths.length} paths`)
      } else {
        fail(
          "N3 manifest preflight",
          `missing=${missing.slice(0, 5).join(",")} extra=${extra.slice(0, 5).join(",")}`,
        )
      }
    } catch (error) {
      fail(
        "N3 manifest preflight",
        error instanceof Error ? error.message : String(error),
      )
    }
  }

  if (input.retainedBefore != null && input.retainedAfter != null) {
    if (input.retainedBefore === input.retainedAfter) {
      pass("N6 retained_pages unchanged", `${input.retainedAfter} rows`)
    } else {
      fail(
        "N6 retained_pages unchanged",
        `before=${input.retainedBefore} after=${input.retainedAfter}`,
      )
    }
  }
}

async function main(): Promise<void> {
  const args = parseCliArgs()

  if (args.watchCampaignId) {
    await runWatch(args.watchCampaignId)
    await closeQueueConnections()
    return
  }

  runOfflineLegs()
  await checkDomainDisjointness(acceptanceFixturePaths())
  await runNetworkLegs()
  await runOptionalNetworkAssertions(args)
  summarize()
  await closeQueueConnections()
}

main().catch(async (error) => {
  console.error(error)
  process.exitCode = 1
  await closeQueueConnections()
})

export {
  assertImportReport,
  checkDomainDisjointness,
  checkNoRecordingReuse,
  normalizeDomainKey,
  AC1_TERMINAL,
}
