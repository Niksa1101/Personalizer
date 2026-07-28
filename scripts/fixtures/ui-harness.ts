/**
 * Shared Playwright + login scaffolding for UI verify scripts.
 */

import { chromium, type Browser, type BrowserContext, type Page } from "playwright"

import { SESSION_COOKIE_NAME } from "../../lib/session"

export const UI_BASE_URL = "http://127.0.0.1:3000"

export interface CheckResult {
  name: string
  state: "pass" | "fail" | "skip"
  detail: string
}

export function createUiHarness() {
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

  function skip(name: string, reason: string): void {
    results.push({ name, state: "skip", detail: reason })
    console.log(`SKIP  ${name} — ${reason}`)
  }

  return { results, pass, fail, skip }
}

export async function probeServer(
  baseUrl = UI_BASE_URL,
): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/login`, {
      redirect: "manual",
      signal: AbortSignal.timeout(3000),
    })
    return response.status >= 200 && response.status < 500
  } catch {
    return false
  }
}

function getSetCookie(response: Response): string[] {
  const headers = response.headers as Headers & {
    getSetCookie?: () => string[]
  }
  if (typeof headers.getSetCookie === "function") {
    return headers.getSetCookie()
  }
  const single = response.headers.get("set-cookie")
  return single ? [single] : []
}

function parseCookies(setCookies: string[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const header of setCookies) {
    const part = header.split(";")[0]
    const eq = part.indexOf("=")
    if (eq > 0) {
      map.set(part.slice(0, eq), part.slice(eq + 1))
    }
  }
  return map
}

export async function loginSessionCookie(
  password: string,
  baseUrl = UI_BASE_URL,
): Promise<{ cookie: string } | { reason: string }> {
  let response: Response
  try {
    response = await fetch(`${baseUrl}/api/login`, {
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
    return { reason: `login 200 but no ${SESSION_COOKIE_NAME} cookie` }
  }
  return { cookie }
}

export async function launchAuthenticatedPage(
  cookie: string,
  baseUrl = UI_BASE_URL,
): Promise<{ browser: Browser; context: BrowserContext; page: Page }> {
  const browser = await chromium.launch()
  const context = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
  })
  await context.addCookies([
    { name: SESSION_COOKIE_NAME, value: cookie, url: baseUrl },
  ])
  const page = await context.newPage()
  return { browser, context, page }
}

export function printUiSummary(results: CheckResult[]): void {
  const passed = results.filter((r) => r.state === "pass").length
  const failed = results.filter((r) => r.state === "fail").length
  const skipped = results.filter((r) => r.state === "skip").length
  console.log(`\nSummary: ${passed} passed, ${failed} failed, ${skipped} skipped`)
}

export {
  DEFAULT_POLL_MS,
  QUEUE_POLL_MS,
} from "../../lib/queue-health-poller"

export function countRequests(
  page: Page,
  pattern: string | RegExp,
): { getCount: () => number; reset: () => void; stop: () => void } {
  const matches: string[] = []
  const handler = (request: { url: () => string }) => {
    const url = request.url()
    const hit =
      typeof pattern === "string" ? url.includes(pattern) : pattern.test(url)
    if (hit) matches.push(url)
  }
  page.on("request", handler)
  return {
    getCount: () => matches.length,
    reset: () => {
      matches.length = 0
    },
    stop: () => {
      page.off("request", handler)
    },
  }
}
