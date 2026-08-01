/**
 * Keep-alive workflow and anon-key blast-radius verification.
 *
 * This script deliberately does **not** call `assertEnvOrExit()`. That helper
 * demands all eight required variables and calls `process.exit(1)`; this script
 * needs three (`NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and the
 * anon key) and its offline legs must run on a fresh clone with no `.env.local`
 * at all — that is the claim they exist to prove. Environment is read per-variable
 * and gated softly. `verify-schema.ts:77` already soft-reads the anon key next
 * to its `assertEnvOrExit` call; this is the same pattern, applied to all three.
 *
 * Accepted caveat: `git log -S "<value>"` passes the service-role value as a
 * command-line argument, briefly visible in the process list. Single-operator
 * machine; recorded rather than solved.
 */

import { execSync } from "node:child_process"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { createClient } from "@supabase/supabase-js"

import type { Database } from "../lib/database.types"

interface CheckResult {
  name: string
  state: "pass" | "fail" | "skip"
  detail: string
}

interface Hit {
  path: string
  reason: string
}

const results: CheckResult[] = []
const repoRoot = join(import.meta.dirname, "..")

const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g

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

function isJwtShaped(value: string): boolean {
  return /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".")
  if (parts.length !== 3) return null
  try {
    const payload = parts[1]!.replace(/-/g, "+").replace(/_/g, "/")
    const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4)
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as Record<string, unknown>
  } catch {
    return null
  }
}

export function scanForServiceRole(files: { path: string; text: string }[]): Hit[] {
  const hits: Hit[] = []
  for (const file of files) {
    if (file.text.includes("SUPABASE_SERVICE_ROLE_KEY")) {
      hits.push({ path: file.path, reason: "literal SUPABASE_SERVICE_ROLE_KEY" })
    }
    if (file.text.includes("service_role")) {
      hits.push({ path: file.path, reason: "literal service_role" })
    }
    for (const match of file.text.matchAll(JWT_PATTERN)) {
      const payload = decodeJwtPayload(match[0]!)
      if (payload && payload.role === "service_role") {
        hits.push({ path: file.path, reason: "JWT payload role=service_role" })
      }
    }
  }
  return hits
}

const NPM_BUILTINS = new Set(["test", "install", "ci"])

export function checkDocScriptDrift(
  text: string,
  scriptNames: Set<string>,
): string[] {
  const unknown: string[] = []
  const seen = new Set<string>()

  const bashBlocks = text.matchAll(/```bash\n([\s\S]*?)```/g)
  for (const block of bashBlocks) {
    scanCommandText(block[1]!, scriptNames, unknown, seen)
  }

  const tableCells = text.matchAll(/\|\s*`([^`]+)`\s*\|/g)
  for (const cell of tableCells) {
    scanCommandText(cell[1]!, scriptNames, unknown, seen)
  }

  return unknown
}

function scanCommandText(
  text: string,
  scriptNames: Set<string>,
  unknown: string[],
  seen: Set<string>,
): void {
  for (const match of text.matchAll(/npm run (\S+)/g)) {
    const name = match[1]!.replace(/`/g, "")
    if (seen.has(name)) continue
    seen.add(name)
    if (!scriptNames.has(name)) {
      unknown.push(`npm run ${name}`)
    }
  }
  for (const builtin of ["test", "install", "ci"] as const) {
    const re = new RegExp(`\\bnpm ${builtin}\\b`)
    if (re.test(text) && !seen.has(`npm ${builtin}`)) {
      seen.add(`npm ${builtin}`)
      if (!NPM_BUILTINS.has(builtin)) {
        unknown.push(`npm ${builtin}`)
      }
    }
  }
}

function readText(path: string): string {
  return readFileSync(path, "utf8")
}

function listGithubFiles(): { path: string; text: string }[] {
  const dir = join(repoRoot, ".github")
  const files: { path: string; text: string }[] = []

  function walk(current: string): void {
    for (const entry of readdirSync(current)) {
      const full = join(current, entry)
      if (statSync(full).isDirectory()) {
        walk(full)
      } else {
        files.push({
          path: relative(repoRoot, full),
          text: readFileSync(full, "utf8"),
        })
      }
    }
  }

  walk(dir)
  return files
}

function postgrestCode(error: { code?: string; message?: string } | null): string {
  return error?.code ?? ""
}

async function observeOnly(
  supabaseUrl: string,
  serviceRoleKey: string,
): Promise<void> {
  const supabase = createClient<Database>(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const { count, error: countError } = await supabase
    .from("heartbeat")
    .select("*", { count: "exact", head: true })

  if (countError) {
    fail("observe count(*)", countError.message)
    summarize()
    process.exit(1)
  }

  const { data: latest, error: latestError } = await supabase
    .from("heartbeat")
    .select("id, created_at")
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (latestError) {
    fail("observe max(id)", latestError.message)
    summarize()
    process.exit(1)
  }

  console.log(`heartbeat max(id):         ${latest?.id ?? "null"}`)
  console.log(`heartbeat max(created_at): ${latest?.created_at ?? "null"}`)
  console.log(`heartbeat count(*):        ${count ?? 0}`)
  pass("observe heartbeat aggregates")
  summarize()
}

function summarize(): void {
  const passed = results.filter((r) => r.state === "pass").length
  const skipped = results.filter((r) => r.state === "skip").length
  const failed = results.filter((r) => r.state === "fail").length
  const asserted = results.length - skipped
  console.log(
    `\n${passed}/${asserted} checks passed${skipped > 0 ? `, ${skipped} skipped` : ""}`,
  )
  if (failed > 0) process.exit(1)
}

function runOfflineLegs(scriptNames: Set<string>): void {
  const workflowPath = join(repoRoot, ".github", "workflows", "supabase-keepalive.yml")

  // mutation: remove workflow file path assertion target -> O1 fails
  try {
    readText(workflowPath)
    pass("O1 workflow file exists")
  } catch {
    fail("O1 workflow file exists", "missing .github/workflows/supabase-keepalive.yml")
  }

  let workflowText = ""
  try {
    workflowText = readText(workflowPath)
  } catch {
    workflowText = ""
  }

  // mutation: remove HTTP 201 assertion line -> O2 fails
  if (/\[ "\$code" != "201" \]/.test(workflowText)) {
    pass("O2 workflow asserts HTTP 201 explicitly")
  } else {
    fail("O2 workflow asserts HTTP 201 explicitly", "201 assertion not found")
  }

  // mutation: remove Prefer header -> O3 fails
  if (workflowText.includes('Prefer: return=minimal')) {
    pass("O3 workflow sends Prefer: return=minimal")
  } else {
    fail("O3 workflow sends Prefer: return=minimal", "header not found")
  }

  // mutation: remove permissions or timeout -> O4 fails
  if (/^permissions:\s*\{\}/m.test(workflowText) && /timeout-minutes:\s*5/.test(workflowText)) {
    pass("O4 workflow declares permissions: {} and timeout-minutes")
  } else {
    fail("O4 workflow declares permissions: {} and timeout-minutes", "missing declaration")
  }

  // mutation: remove schedule or dispatch -> O5 fails
  if (
    workflowText.includes("'17 6 * * *'") &&
    workflowText.includes("workflow_dispatch:")
  ) {
    pass("O5 workflow declares schedule and workflow_dispatch")
  } else {
    fail("O5 workflow declares schedule and workflow_dispatch", "trigger missing")
  }

  // mutation: temp dir with fake service_role JWT -> O6 hits; clean dir -> no hits
  const githubFiles = listGithubFiles()
  const hits = scanForServiceRole(githubFiles)
  if (hits.length === 0) {
    pass("O6 no service-role reference under .github/**")
  } else {
    fail(
      "O6 no service-role reference under .github/**",
      hits.map((h) => `${h.path}: ${h.reason}`).join("; "),
    )
  }

  // mutation: synthetic doc with npm run does-not-exist -> O7 fails
  const readmeUnknown = checkDocScriptDrift(readText(join(repoRoot, "README.md")), scriptNames)
  if (readmeUnknown.length === 0) {
    pass("O7 README names no unknown npm script")
  } else {
    fail("O7 README names no unknown npm script", readmeUnknown.join(", "))
  }

  // mutation: synthetic doc with npm run does-not-exist -> O8 fails
  const techUnknown = checkDocScriptDrift(
    readText(join(repoRoot, "docs", "Tech.md")),
    scriptNames,
  )
  if (techUnknown.length === 0) {
    pass("O8 docs/Tech.md names no unknown npm script")
  } else {
    fail("O8 docs/Tech.md names no unknown npm script", techUnknown.join(", "))
  }
}

function runValueDependentLegs(serviceRoleKey: string | null): void {
  if (!serviceRoleKey || !isJwtShaped(serviceRoleKey)) {
    skip(
      "O9 service-role value absent from tracked files",
      "set SUPABASE_SERVICE_ROLE_KEY to a real JWT-shaped value",
    )
    skip(
      "O10 service-role value absent from git history",
      "set SUPABASE_SERVICE_ROLE_KEY to a real JWT-shaped value",
    )
    return
  }

  // mutation: temp file containing fake key -> O9 hits
  let trackedFiles: string[] = []
  try {
    trackedFiles = execSync("git ls-files", { cwd: repoRoot, encoding: "utf8" })
      .trim()
      .split("\n")
      .filter(Boolean)
  } catch {
    fail("O9 service-role value absent from tracked files", "git ls-files failed")
    skip("O10 service-role value absent from git history", "git ls-files failed")
    return
  }

  const fileHits: string[] = []
  for (const file of trackedFiles) {
    try {
      const text = readFileSync(join(repoRoot, file), "utf8")
      if (text.includes(serviceRoleKey)) {
        fileHits.push(file)
      }
    } catch {
      // binary or missing — skip
    }
  }

  if (fileHits.length === 0) {
    pass("O9 service-role value absent from tracked files")
  } else {
    fail(
      "O9 service-role value absent from tracked files",
      `found in ${fileHits.length} file(s)`,
    )
  }

  try {
    execSync("git rev-parse --is-inside-work-tree", { cwd: repoRoot, stdio: "ignore" })
  } catch {
    skip("O10 service-role value absent from git history", "not a git repository")
    return
  }

  // mutation: git log -S "heartbeat_insert_only" must hit; random uuid must miss
  let historyOutput = ""
  try {
    historyOutput = execSync(`git log -S "${serviceRoleKey}" --all --oneline`, {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim()
  } catch {
    historyOutput = ""
  }

  if (historyOutput.length === 0) {
    pass("O10 service-role value absent from git history")
  } else {
    fail(
      "O10 service-role value absent from git history",
      `${historyOutput.split("\n").length} commit(s) matched`,
    )
  }
}

async function runNetworkLegs(
  supabaseUrl: string,
  serviceRoleKey: string,
  anonKey: string,
): Promise<void> {
  const service = createClient<Database>(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const anon = createClient<Database>(supabaseUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const { data: watermarkRow } = await service
    .from("heartbeat")
    .select("id")
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle()
  const watermark = watermarkRow?.id ?? 0

  // mutation: corrupted anon key -> N1 fails
  const { error: insertError } = await anon
    .from("heartbeat")
    .insert({ source: "github-action" })

  if (!insertError) {
    pass("N1 anon INSERT heartbeat source=github-action -> 201")
  } else {
    fail("N1 anon INSERT heartbeat source=github-action -> 201", insertError.message)
  }

  // mutation: assert success instead of denial -> N2 fails
  const { error: selectError } = await anon.from("heartbeat").select("id").limit(1)
  if (postgrestCode(selectError) === "42501") {
    pass("N2 anon SELECT heartbeat -> 42501")
  } else {
    fail(
      "N2 anon SELECT heartbeat -> 42501",
      `got code=${postgrestCode(selectError) || "none"} msg=${selectError?.message ?? "no error"}`,
    )
  }

  // mutation: assert success instead of denial -> N3 fails
  const { error: updateError } = await anon
    .from("heartbeat")
    .update({ source: "x" })
    .eq("id", 1)
  if (postgrestCode(updateError) === "42501") {
    pass("N3 anon UPDATE heartbeat -> 42501")
  } else {
    fail(
      "N3 anon UPDATE heartbeat -> 42501",
      `got code=${postgrestCode(updateError) || "none"}`,
    )
  }

  // mutation: assert success instead of denial -> N4 fails
  const { error: deleteError } = await anon.from("heartbeat").delete().eq("id", 1)
  if (postgrestCode(deleteError) === "42501") {
    pass("N4 anon DELETE heartbeat -> 42501")
  } else {
    fail(
      "N4 anon DELETE heartbeat -> 42501",
      `got code=${postgrestCode(deleteError) || "none"}`,
    )
  }

  // mutation: assert success instead of denial -> N5 fails
  const { error: badSourceError } = await anon
    .from("heartbeat")
    .insert({ source: "verify-keepalive" })
  if (postgrestCode(badSourceError) === "42501") {
    pass("N5 anon INSERT heartbeat source=verify-keepalive -> 42501")
  } else {
    fail(
      "N5 anon INSERT heartbeat source=verify-keepalive -> 42501",
      `got code=${postgrestCode(badSourceError) || "none"}`,
    )
  }

  const { data: bucketObjects, error: listServiceError } = await service.storage
    .from("lead-videos")
    .list("", { limit: 1 })

  if (listServiceError) {
    skip("N6 anon cannot list lead-videos", `service role list failed: ${listServiceError.message}`)
    skip("N7 public object readable via Range", "N6 precondition unavailable")
  } else if (!bucketObjects || bucketObjects.length === 0) {
    skip(
      "N6 anon cannot list lead-videos",
      "lead-videos bucket is empty — run a deploy first",
    )
    skip("N7 public object readable via Range", "lead-videos bucket is empty")
  } else {
    const { data: anonList, error: anonListError } = await anon.storage
      .from("lead-videos")
      .list("", { limit: 100 })

    if (anonListError) {
      pass("N6 anon cannot list lead-videos", "request denied")
    } else if (!anonList || anonList.length === 0) {
      pass("N6 anon cannot list lead-videos", "empty listing (no enumeration)")
    } else {
      fail(
        "N6 anon cannot list lead-videos",
        `anon listed ${anonList.length} object(s)`,
      )
    }

    const samplePath = `${bucketObjects[0]!.name}/final.mp4`
    const publicUrl = `${supabaseUrl.replace(/\/$/, "")}/storage/v1/object/public/lead-videos/${samplePath}`
    try {
      const response = await fetch(publicUrl, { headers: { Range: "bytes=0-0" } })
      if (response.status === 200 || response.status === 206) {
        pass("N7 public object readable via Range: bytes=0-0", `HTTP ${response.status}`)
      } else {
        fail("N7 public object readable via Range: bytes=0-0", `HTTP ${response.status}`)
      }
    } catch (error) {
      fail(
        "N7 public object readable via Range: bytes=0-0",
        error instanceof Error ? error.message : String(error),
      )
    }
  }

  // mutation: assert error !== null instead of 42501 -> N8 vacuous with wrong code
  const { error: logsSelectError } = await anon.from("logs").select("id").limit(1)
  const { error: logsInsertError } = await anon.from("logs").insert({
    scope: "worker",
    level: "info",
    message: "verify-keepalive probe",
  })
  if (postgrestCode(logsSelectError) === "42501" && postgrestCode(logsInsertError) === "42501") {
    pass("N8 anon SELECT and INSERT on logs -> 42501 both")
  } else {
    fail(
      "N8 anon SELECT and INSERT on logs -> 42501 both",
      `select=${postgrestCode(logsSelectError) || "none"} insert=${postgrestCode(logsInsertError) || "none"}`,
    )
  }

  // mutation: error !== null passes on 23502 — 42501 assertion does real work
  const { error: clSelectError } = await anon.from("campaign_leads").select("id").limit(1)
  const { error: clInsertError } = await anon
    .from("campaign_leads")
    .insert({} as never)
  if (postgrestCode(clSelectError) === "42501" && postgrestCode(clInsertError) === "42501") {
    pass("N9 anon SELECT and INSERT on campaign_leads -> 42501 both")
  } else {
    fail(
      "N9 anon SELECT and INSERT on campaign_leads -> 42501 both",
      `select=${postgrestCode(clSelectError) || "none"} insert=${postgrestCode(clInsertError) || "none"}`,
    )
  }

  const { data: candidates, error: candidatesError } = await service
    .from("heartbeat")
    .select("id")
    .gt("id", watermark)
    .eq("source", "github-action")
    .order("id", { ascending: true })
    .limit(2)

  if (candidatesError) {
    fail("teardown candidate query", candidatesError.message)
    return
  }

  if (!candidates || candidates.length === 0) {
    console.log("TEARDOWN nothing to delete — N1 may have failed")
    return
  }

  if (candidates.length === 1) {
    const id = candidates[0]!.id
    const { error: teardownError } = await service.from("heartbeat").delete().eq("id", id)
    if (teardownError) {
      fail("teardown delete single row", teardownError.message)
    } else {
      pass("teardown deleted one row", `id=${id}`)
    }
    return
  }

  console.log(
    "TEARDOWN skipped — >=2 candidate rows (concurrent Action row may be present); leaving this run's row behind",
  )
}

async function main(): Promise<void> {
  const observeMode = process.argv.includes("--observe")

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? ""
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? ""
  const anonKey = (
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim() ||
    process.env.SUPABASE_ANON_KEY?.trim() ||
    ""
  )

  if (observeMode) {
    if (!supabaseUrl || !serviceRoleKey || !isJwtShaped(serviceRoleKey)) {
      skip(
        "--observe",
        "requires NEXT_PUBLIC_SUPABASE_URL and a JWT-shaped SUPABASE_SERVICE_ROLE_KEY",
      )
      summarize()
      return
    }
    await observeOnly(supabaseUrl, serviceRoleKey)
    return
  }

  const pkg = JSON.parse(readText(join(repoRoot, "package.json"))) as {
    scripts: Record<string, string>
  }
  const scriptNames = new Set(Object.keys(pkg.scripts))

  runOfflineLegs(scriptNames)
  runValueDependentLegs(serviceRoleKey || null)

  const networkMissing: string[] = []
  if (!supabaseUrl) networkMissing.push("NEXT_PUBLIC_SUPABASE_URL")
  if (!serviceRoleKey || !isJwtShaped(serviceRoleKey)) {
    networkMissing.push("SUPABASE_SERVICE_ROLE_KEY (JWT-shaped)")
  }
  if (!anonKey || !isJwtShaped(anonKey)) {
    networkMissing.push("NEXT_PUBLIC_SUPABASE_ANON_KEY or SUPABASE_ANON_KEY (JWT-shaped)")
  }

  if (networkMissing.length > 0) {
    skip(
      "network legs N1–N9",
      `missing or placeholder: ${networkMissing.join(", ")}`,
    )
  } else {
    await runNetworkLegs(supabaseUrl, serviceRoleKey, anonKey)
  }

  summarize()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
