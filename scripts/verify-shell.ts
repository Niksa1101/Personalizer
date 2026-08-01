/**
 * Shell verification against a running dev server (Phase 3, D30).
 * Does not start the server — fails loudly if nothing is listening.
 */

import { createClient } from "@supabase/supabase-js"

import { ERROR_BOUNDARY_MARKER } from "../app/(app)/error"
import type { Database } from "../lib/database.types"

const BASE_URL = "http://127.0.0.1:3000"

const ROUTES = [
  "/",
  "/leads",
  "/queue",
  "/campaigns",
  "/intros",
  "/import",
  "/logs",
  "/settings",
] as const

interface CheckResult {
  name: string
  ok: boolean
  detail: string
  skipped?: boolean
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

function skip(name: string, reason: string): void {
  results.push({ name, ok: true, detail: reason, skipped: true })
  console.log(`SKIP  ${name} — ${reason}`)
}

/**
 * The one dynamic route in the set. It used to be a hardcoded
 * `/campaigns/00000000-…0001`, which never existed: `seed_demo_data()` inserts
 * the demo campaign with `gen_random_uuid()` and pins only the slug. The leg
 * had been quietly red since Phase 3 and the README repeated the dead URL.
 *
 * Resolved through the database rather than by scraping `/campaigns`, because
 * the campaigns table renders its only `/campaigns/<id>` link inside a
 * dropdown that Base UI portals in on open — the id is not in the server HTML.
 * `createClient` directly, not `getSupabaseAdmin()`: `verify:shell` runs
 * without `--conditions react-server` and importing the server-only module
 * would throw.
 */
async function resolveDemoCampaignRoute(): Promise<
  { route: string } | { skipReason: string }
> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim()
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()

  if (!url || !serviceRoleKey) {
    return {
      skipReason:
        "NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is unset — cannot resolve the demo campaign id",
    }
  }

  const supabase = createClient<Database>(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const { data, error } = await supabase
    .from("campaigns")
    .select("id")
    .eq("slug", "demo")
    .maybeSingle()

  if (error) {
    return { skipReason: `campaign lookup failed: ${error.message}` }
  }
  if (!data) {
    return { skipReason: "no campaign with slug 'demo' — run `npm run seed`" }
  }

  return { route: `/campaigns/${data.id}` }
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

async function main(): Promise<void> {
  if (!(await probeServer())) {
    console.error(
      `Personalizer dev server is not reachable at ${BASE_URL}.\n` +
        "Start it with `npm run dev` in another terminal, then rerun `npm run verify:shell`.",
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

  const demo = await resolveDemoCampaignRoute()
  const routes: string[] = [...ROUTES]
  if ("route" in demo) {
    routes.push(demo.route)
  } else {
    skip("GET /campaigns/<demo campaign>", demo.skipReason)
  }

  for (const route of routes) {
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

  const failed = results.filter((result) => !result.ok)
  const skipped = results.filter((result) => result.skipped)
  const passed = results.filter((result) => result.ok && !result.skipped)

  console.log("")
  console.log(
    `Summary: ${passed.length} passed, ${failed.length} failed` +
      (skipped.length > 0 ? `, ${skipped.length} skipped` : ""),
  )

  if (failed.length > 0) {
    process.exit(1)
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
