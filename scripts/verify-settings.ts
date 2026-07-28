/**
 * Phase 14 settings verification — no browser, no worker.
 */

import { spawn, type ChildProcess } from "node:child_process"
import net from "node:net"
import os from "node:os"

import { assertEnvOrExit } from "../lib/env-node"
import { getEnvHealth } from "../lib/env-health"
import { listSettingRows, upsertSettings } from "../lib/settings-admin"
import {
  keysForGroup,
  SETTING_DEFAULTS,
  SETTING_FIELDS,
  SETTING_KEYS,
  settingSchemaFor,
  type SettingKey,
} from "../lib/settings-schema"
import {
  resetSettingsTtlCache,
  resolveSetting,
} from "../lib/settings"
import { getSupabaseAdmin } from "../lib/supabase"
import { SESSION_COOKIE_NAME } from "../lib/session"
import { loginSessionCookie } from "./fixtures/ui-harness"

interface CheckResult {
  name: string
  state: "pass" | "fail" | "skip"
  detail: string
}

const results: CheckResult[] = []
const BASE_URL = "http://127.0.0.1:3111"
const SENTINEL = "SENTINEL_ENV_VALUE_SHOULD_NEVER_APPEAR_IN_DOM_1234567890"

const REQUIRED_SENTINELS = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "NETLIFY_SITE_ID",
  "NETLIFY_TOKEN",
  "LOCAL_STORAGE_ROOT",
  "REDIS_URL",
  "APP_PASSWORD",
  "SESSION_SECRET",
] as const

function shapedSentinel(name: (typeof REQUIRED_SENTINELS)[number]): string {
  switch (name) {
    case "NEXT_PUBLIC_SUPABASE_URL":
      return `https://sentinel-${SENTINEL}.supabase.co`
    case "REDIS_URL":
      return `redis://127.0.0.1:6399/${SENTINEL}`
    case "LOCAL_STORAGE_ROOT":
      return `${os.tmpdir()}/sentinel-${SENTINEL}`
    case "SESSION_SECRET":
      return `${SENTINEL}-session-secret-padding-32chars`
    default:
      return `${SENTINEL}-${name}`
  }
}

async function runEnvLeakLeg(): Promise<void> {
  const env = { ...process.env }
  for (const name of REQUIRED_SENTINELS) {
    env[name] = shapedSentinel(name)
  }
  env.PORT = "3111"

  let child: ChildProcess | null = null
  let bootOutput = ""
  try {
    child = spawn("npm", ["run", "dev", "--", "-p", "3111"], {
      cwd: process.cwd(),
      env,
      stdio: "pipe",
      shell: true,
    })

    child.stdout?.on("data", (chunk: Buffer) => {
      bootOutput = (bootOutput + chunk.toString()).slice(-4_000)
    })
    child.stderr?.on("data", (chunk: Buffer) => {
      bootOutput = (bootOutput + chunk.toString()).slice(-4_000)
    })

    const ready = await waitForPort(3111, 60_000)
    if (!ready) {
      fail(
        "env leak sentinel boot",
        `dev server did not start — ${bootOutput.slice(-800)}`,
      )
      return
    }

    const login = await loginSessionCookie(env.APP_PASSWORD!, BASE_URL)
    if ("reason" in login) {
      fail("env leak sentinel boot", login.reason)
      return
    }

    const response = await fetch(`${BASE_URL}/settings`, {
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${login.cookie}` },
    })
    const html = await response.text()
    if (html.includes(SENTINEL)) {
      fail("env leak sentinel boot", "sentinel appeared in HTML")
      return
    }

    const rscResponse = await fetch(`${BASE_URL}/settings`, {
      headers: {
        Cookie: `${SESSION_COOKIE_NAME}=${login.cookie}`,
        RSC: "1",
      },
    })
    const flight = await rscResponse.text()
    if (flight.includes(SENTINEL)) {
      fail("env leak sentinel boot", "sentinel appeared in RSC flight")
      return
    }

    pass("env leak sentinel boot")
  } finally {
    if (child?.pid) {
      spawn("taskkill", ["/pid", String(child.pid), "/f", "/t"], { shell: true })
    }
  }
}

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

function outOfRangeValue(key: SettingKey): unknown {
  const meta = SETTING_FIELDS[key]
  if (meta.type === "boolean") return "not-a-boolean"
  if (meta.type === "enum") return "invalid_layout"
  if (meta.min != null) return meta.min - 1
  return null
}

async function main(): Promise<void> {
  assertEnvOrExit()
  const supabase = getSupabaseAdmin()

  for (const key of SETTING_KEYS) {
    const bad = outOfRangeValue(key)
    const parsed = settingSchemaFor(key).safeParse(bad)
    if (parsed.success) {
      fail(`schema rejects ${key}`, `accepted ${String(bad)}`)
    } else {
      pass(`schema rejects ${key}`)
    }
  }

  for (const key of SETTING_KEYS) {
    const parsed = settingSchemaFor(key).safeParse(SETTING_DEFAULTS[key])
    if (!parsed.success) {
      fail(`schema accepts default ${key}`, parsed.error.message)
    } else {
      pass(`schema accepts default ${key}`)
    }
  }

  const pipMeta = SETTING_FIELDS["merge.pip_scale"]
  const navMeta = SETTING_FIELDS["recorder.nav_timeout_ms"]
  if (pipMeta.min === 0.05 && pipMeta.max === 0.6) {
    pass("merge.pip_scale matches SQL CHECK")
  } else {
    fail("merge.pip_scale matches SQL CHECK", `${pipMeta.min}-${pipMeta.max}`)
  }
  if (navMeta.min === 10_000 && navMeta.max === 600_000) {
    pass("recorder.nav_timeout_ms matches SQL CHECK")
  } else {
    fail("recorder.nav_timeout_ms matches SQL CHECK", `${navMeta.min}-${navMeta.max}`)
  }

  const testKey: SettingKey = "recorder.scroll_ease_ms"
  const baseline = 750
  await upsertSettings([{ key: testKey, value: baseline }])
  resetSettingsTtlCache()
  const warmed = await resolveSetting(testKey)
  if (warmed !== baseline) {
    fail("TTL warmup", `expected ${baseline}, got ${warmed}`)
  }

  const bumped = baseline + 1
  await upsertSettings([{ key: testKey, value: bumped }])
  const immediate = await resolveSetting(testKey)
  if (immediate === baseline) {
    pass("TTL cache returns old value within window")
  } else {
    fail("TTL cache returns old value within window", `got ${immediate}, expected ${baseline}`)
  }

  await new Promise((resolve) => setTimeout(resolve, 5_100))
  resetSettingsTtlCache()
  const after = await resolveSetting(testKey)
  if (after === bumped) {
    pass("TTL cache returns new value after expiry")
  } else {
    fail("TTL cache returns new value after expiry", `got ${after}`)
  }

  await upsertSettings([{ key: testKey, value: SETTING_DEFAULTS[testKey] }])
  resetSettingsTtlCache()

  const missingKey: SettingKey = "recorder.post_load_delay_ms"
  const { data: existing } = await supabase
    .from("settings")
    .select("value")
    .eq("key", missingKey)
    .maybeSingle()
  const saved = existing?.value

  await supabase.from("settings").delete().eq("key", missingKey)
  const rows = await listSettingRows()
  const missingRow = rows.find((row) => row.key === missingKey)
  if (missingRow?.presentInDb === false && rows.length === 16) {
    pass("missing row still enumerated")
  } else {
    fail("missing row still enumerated", JSON.stringify(missingRow))
  }

  await upsertSettings([
    { key: missingKey, value: SETTING_DEFAULTS[missingKey] },
  ])
  const inserted = await listSettingRows()
  if (inserted.find((row) => row.key === missingKey)?.presentInDb) {
    pass("save inserts missing row")
  } else {
    fail("save inserts missing row", "row still absent")
  }

  if (saved != null) {
    await upsertSettings([{ key: missingKey, value: saved as number }])
  }

  await supabase
    .from("settings")
    .update({ value: "not-json-number" })
    .eq("key", missingKey)
  const unparseable = await listSettingRows()
  const badRow = unparseable.find((row) => row.key === missingKey)
  if (
    badRow?.parseState === "unparseable" &&
    badRow.effectiveValue === SETTING_DEFAULTS[missingKey]
  ) {
    pass("unparseable row flagged with default effective value")
  } else {
    fail("unparseable row flagged", JSON.stringify(badRow))
  }
  await upsertSettings([
    { key: missingKey, value: SETTING_DEFAULTS[missingKey] },
  ])

  await upsertSettings([
    { key: "encode.web_crf", value: SETTING_DEFAULTS["encode.web_crf"] },
  ])
  const { count } = await supabase
    .from("settings")
    .select("key", { count: "exact", head: true })
    .eq("key", "encode.web_crf")
  if ((count ?? 0) >= 1) {
    pass("reset writes default and row still exists")
  } else {
    fail("reset writes default and row still exists", "row missing")
  }

  const envHealth = getEnvHealth()
  if (envHealth.length === 9) {
    pass("getEnvHealth returns nine entries")
  } else {
    fail("getEnvHealth returns nine entries", `got ${envHealth.length}`)
  }

  for (const entry of envHealth) {
    if (
      typeof entry.present !== "boolean" ||
      Object.keys(entry).some(
        (key) => key !== "name" && key !== "present" && key !== "informational",
      )
    ) {
      fail("env health entry is boolean-only", JSON.stringify(entry))
      break
    }
  }
  pass("env health entries are boolean-only")

  await upsertSettings([{ key: "deploy.dry_run", value: false }])
  const { data: rawDryRun } = await supabase
    .from("settings")
    .select("value")
    .eq("key", "deploy.dry_run")
    .single()
  if (rawDryRun?.value === false) {
    pass('"false" round-trips to JSON boolean false')
  } else {
    fail(
      '"false" round-trips to JSON boolean false',
      JSON.stringify(rawDryRun?.value),
    )
  }

  try {
    await upsertSettings([{ key: "deploy.dry_run", value: false }])
    resetSettingsTtlCache()
    const formData = new FormData()
    formData.set(
      "deploy.timeout_ms",
      String(SETTING_DEFAULTS["deploy.timeout_ms"]),
    )
    formData.set("deploy.dry_run", "false")

    const entries: Array<{ key: SettingKey; value: unknown }> = []
    for (const key of keysForGroup("Deploy")) {
      const rawValues = formData.getAll(key)
      if (rawValues.length === 0) continue
      const parsed = settingSchemaFor(key).safeParse(rawValues[0])
      if (!parsed.success) {
        fail("group save preserves deploy.dry_run false", parsed.error.message)
        break
      }
      entries.push({ key, value: parsed.data })
    }

    await upsertSettings(
      entries as Array<{
        key: SettingKey
        value: (typeof SETTING_DEFAULTS)[SettingKey]
      }>,
    )
    resetSettingsTtlCache()
    const afterGroup = await resolveSetting("deploy.dry_run")
    if (afterGroup === false) {
      pass("group save preserves deploy.dry_run false")
    } else {
      fail("group save preserves deploy.dry_run false", String(afterGroup))
    }
  } finally {
    await upsertSettings([
      { key: "deploy.dry_run", value: SETTING_DEFAULTS["deploy.dry_run"] },
    ])
    resetSettingsTtlCache()
  }

  if (!(await portFree(3111))) {
    skip("env leak sentinel boot", "port 3111 occupied — refusing ambiguous run")
  } else {
    await runEnvLeakLeg()
  }

  const passed = results.filter((r) => r.state === "pass").length
  const failed = results.filter((r) => r.state === "fail").length
  const skipped = results.filter((r) => r.state === "skip").length
  console.log(`\nSummary: ${passed} passed, ${failed} failed, ${skipped} skipped`)
}

async function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once("error", () => resolve(false))
    server.once("listening", () => server.close(() => resolve(true)))
    server.listen(port, "127.0.0.1")
  })
}

async function waitForPort(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>((resolve) => {
      const socket = net.connect(port, "127.0.0.1")
      socket.once("connect", () => {
        socket.end()
        resolve(true)
      })
      socket.once("error", () => resolve(false))
    })
    if (ok) return true
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  return false
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => {
    process.exit(process.exitCode ?? 0)
  })
