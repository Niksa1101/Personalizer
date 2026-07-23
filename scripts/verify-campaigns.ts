/**
 * Campaign CRUD verification against a running dev server (Phase 4).
 * Does not start the server — fails loudly if nothing is listening.
 *
 * Deliberately does NOT import lib/campaigns.ts — that module carries
 * `server-only`, which throws when resolved outside a bundler.
 */

import { createClient } from "@supabase/supabase-js"

import { ERROR_BOUNDARY_MARKER } from "../app/(app)/error"
import type { Database } from "../lib/database.types"
import { assertEnvOrExit } from "../lib/env-node"
import { DEFAULT_LANDING_TEMPLATE } from "../lib/landing-template"

const BASE_URL = "http://127.0.0.1:3000"

const ROUTES = ["/campaigns", "/campaigns/new"] as const

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
    const name = pair.slice(0, eq).trim()
    const value = pair.slice(eq + 1).trim()
    jar.set(name, value)
  }

  return jar
}

async function login(): Promise<string | null> {
  const password = process.env.APP_PASSWORD?.trim()
  if (!password) {
    console.error("APP_PASSWORD is not set. Load .env.local or export it before running.")
    process.exit(1)
  }

  const response = await fetch(`${BASE_URL}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  })

  const jar = parseCookies(getSetCookie(response))
  return jar.get("pz_session") ?? null
}

async function checkRoute(cookieHeader: string, route: string): Promise<void> {
  const response = await fetch(`${BASE_URL}${route}`, {
    redirect: "manual",
    headers: { Cookie: cookieHeader },
  })
  const body = await response.text()
  const hasErrorBoundary =
    body.includes(ERROR_BOUNDARY_MARKER) ||
    body.includes("Something went wrong")

  if (response.status === 200 && !hasErrorBoundary) {
    pass(`GET ${route}`)
  } else {
    fail(
      `GET ${route}`,
      `status=${response.status}, errorBoundary=${hasErrorBoundary}`,
    )
  }
}

async function roundTrip(
  supabase: ReturnType<typeof createClient<Database>>,
): Promise<void> {
  const suffix = Date.now().toString(36)
  const name = `Verify ${suffix}`
  const slug = `verify-${suffix}`

  const { data: created, error: createError } = await supabase
    .from("campaigns")
    .insert({
      name,
      slug,
      description: "verify:campaigns round-trip",
      landing_template: DEFAULT_LANDING_TEMPLATE,
    })
    .select("id, ref, slug")
    .single()

  if (createError || !created) {
    fail("createCampaign", createError?.message ?? "no row returned")
    return
  }
  pass("createCampaign", created.ref)

  const { data: updated, error: updateError } = await supabase
    .from("campaigns")
    .update({ name: `${name} Updated`, description: "updated" })
    .eq("id", created.id)
    .select("name")
    .single()

  if (updateError || !updated?.name.endsWith("Updated")) {
    fail("updateCampaignGeneral", updateError?.message ?? "name not updated")
  } else {
    pass("updateCampaignGeneral")
  }

  const { error: archiveError } = await supabase
    .from("campaigns")
    .update({ archived_at: new Date().toISOString() })
    .eq("id", created.id)

  const { data: archived } = await supabase
    .from("campaigns")
    .select("archived_at")
    .eq("id", created.id)
    .single()

  if (archiveError || !archived?.archived_at) {
    fail("archiveCampaign", archiveError?.message ?? "archived_at not set")
  } else {
    pass("archiveCampaign")
  }

  const { data: visible } = await supabase
    .from("campaigns")
    .select("id")
    .is("archived_at", null)
    .eq("id", created.id)

  if (visible?.length) {
    fail("listCampaigns hidden archived", "campaign still visible")
  } else {
    pass("listCampaigns hides archived")
  }

  const { error: unarchiveError } = await supabase
    .from("campaigns")
    .update({ archived_at: null })
    .eq("id", created.id)

  const { data: unarchived } = await supabase
    .from("campaigns")
    .select("archived_at")
    .eq("id", created.id)
    .single()

  if (unarchiveError || unarchived?.archived_at) {
    fail("unarchiveCampaign", unarchiveError?.message ?? "archived_at still set")
  } else {
    pass("unarchiveCampaign")
  }

  const { error: deleteError } = await supabase
    .from("campaigns")
    .delete()
    .eq("id", created.id)

  const { data: deleted } = await supabase
    .from("campaigns")
    .select("id")
    .eq("id", created.id)
    .maybeSingle()

  if (deleteError || deleted) {
    fail("deleteCampaign", deleteError?.message ?? "campaign still exists")
  } else {
    pass("deleteCampaign")
  }
}

async function main(): Promise<void> {
  if (!(await probeServer())) {
    console.error(
      `Personalizer dev server is not reachable at ${BASE_URL}.\n` +
        "Start it with `npm run dev` in another terminal, then rerun `npm run verify:campaigns`.",
    )
    process.exit(1)
  }

  const sessionCookie = await login()
  if (!sessionCookie) {
    fail("Session login", "could not obtain pz_session cookie")
    process.exit(1)
  }
  pass("Session login")

  const cookieHeader = `pz_session=${sessionCookie}`

  for (const route of ROUTES) {
    await checkRoute(cookieHeader, route)
  }

  const env = assertEnvOrExit()
  const supabase = createClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } },
  )

  const { data: seedCampaigns } = await supabase
    .from("campaigns")
    .select("id")
    .order("created_at", { ascending: false })
    .limit(1)

  const detailId = seedCampaigns?.[0]?.id
  if (detailId) {
    await checkRoute(cookieHeader, `/campaigns/${detailId}`)
  } else {
    fail("GET /campaigns/[id]", "no seed campaign to probe")
  }

  try {
    await roundTrip(supabase)
  } catch (error) {
    fail(
      "round-trip",
      error instanceof Error ? error.message : String(error),
    )
  }

  const failed = results.filter((result) => !result.ok)
  const passed = results.filter((result) => result.ok)

  console.log("")
  console.log(`Summary: ${passed.length} passed, ${failed.length} failed`)

  if (failed.length > 0) {
    process.exit(1)
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
