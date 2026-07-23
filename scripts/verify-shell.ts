/**
 * Shell verification against a running dev server (Phase 3, D30).
 * Does not start the server — fails loudly if nothing is listening.
 */

import { ERROR_BOUNDARY_MARKER } from "../app/(app)/error"

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
  "/campaigns/00000000-0000-0000-0000-000000000001",
] as const

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

  for (const route of ROUTES) {
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
