/**
 * Phase 14 queue UI verification — Playwright.
 */

import { spawn, type ChildProcess } from "node:child_process"

import { createClient } from "@supabase/supabase-js"

import type { Database } from "../lib/database.types"
import { assertEnvOrExit } from "../lib/env-node"
import { closeQueueConnections } from "../lib/queue"
import { pendingJobIds, removeJobsThisRunOrphaned } from "./queue-sweep"
import {
  countRequests,
  createUiHarness,
  DEFAULT_POLL_MS,
  killProcessTree,
  launchAuthenticatedPage,
  loginSessionCookie,
  probeServer,
  printUiSummary,
  QUEUE_POLL_MS,
  UI_BASE_URL,
} from "./fixtures/ui-harness"

const HEALTH_PATTERN = /\/api\/queue\/health/
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function main(): Promise<void> {
  const { results, pass, fail, skip } = createUiHarness()
  const env = assertEnvOrExit()
  const supabase = createClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.SUPABASE_SERVICE_ROLE_KEY,
  )

  if (!(await probeServer())) {
    skip("all legs", "dev server not reachable")
    printUiSummary(results)
    process.exit(0)
  }

  const login = await loginSessionCookie(env.APP_PASSWORD)
  if ("reason" in login) {
    skip("all legs", login.reason)
    printUiSummary(results)
    process.exit(0)
  }

  const pendingBefore = await pendingJobIds()
  const { browser, page } = await launchAuthenticatedPage(login.cookie)

  try {
    const tracker = countRequests(page, HEALTH_PATTERN)

    await page.goto(`${UI_BASE_URL}/queue`, { waitUntil: "domcontentloaded" })
    await page.waitForTimeout(500)

    // "banner absent when healthy" is asserted further down, once this script
    // has a worker running. Checked here it passed whenever the first poll had
    // not landed yet — the banner is empty before any health data arrives.
    const status = page.locator('[role="status"]')
    if ((await status.count()) === 1) {
      pass("role=status present from first paint")
    } else {
      fail("role=status present from first paint", `count=${await status.count()}`)
    }

    let mutations = 0
    let last = await status.innerText()
    const started = Date.now()
    while (Date.now() - started < 6_000) {
      await page.waitForTimeout(500)
      const next = await status.innerText()
      if (next !== last) {
        mutations += 1
        last = next
      }
    }
    if (mutations <= 1) {
      pass("banner text stable across polls")
    } else {
      fail("banner text stable across polls", `${mutations} changes`)
    }

    tracker.reset()
    await page.waitForTimeout(10_000)
    const queuePollMax = Math.ceil(10_000 / QUEUE_POLL_MS) + 2
    if (tracker.getCount() <= queuePollMax) {
      pass("health polling is throttled", `${tracker.getCount()} requests`)
    } else {
      fail(
        "health polling is throttled",
        `${tracker.getCount()} requests in 10s (max ${queuePollMax})`,
      )
    }

    await page.goto(`${UI_BASE_URL}/settings`, { waitUntil: "domcontentloaded" })
    tracker.reset()
    await page.waitForTimeout(10_000)
    const sharedPollMax = Math.ceil(10_000 / DEFAULT_POLL_MS) + 2
    if (tracker.getCount() <= sharedPollMax) {
      pass("one shared poller across consumers", `${tracker.getCount()} requests`)
    } else {
      fail(
        "one shared poller across consumers",
        `${tracker.getCount()} requests in 10s (max ${sharedPollMax})`,
      )
    }

    await page.goto(`${UI_BASE_URL}/queue`, { waitUntil: "domcontentloaded" })
    // `health` is null until the first poll lands, so the card renders its
    // other branch on first paint. Asserting immediately raced that and the
    // leg skipped itself every run.
    const concurrencyCard = page.getByText("no worker running")
    try {
      await concurrencyCard.first().waitFor({ state: "visible", timeout: 15_000 })
      pass("concurrency shows no worker running")
    } catch {
      const bannerNow = await page.locator('[role="status"]').innerText()
      if (!bannerNow.includes("No worker running")) {
        skip("concurrency shows no worker running", "a worker is live")
      } else {
        fail(
          "concurrency shows no worker running",
          "banner reports no worker but the concurrency card does not",
        )
      }
    }

    let worker: ChildProcess | null = spawn("npm", ["run", "worker"], {
      cwd: process.cwd(),
      shell: true,
      stdio: "ignore",
    })
    try {
      await page.waitForTimeout(3_000)
      await page.reload({ waitUntil: "domcontentloaded" })
      try {
        await page.waitForFunction(
          () => {
            const el = document.querySelector('[role="status"]')
            return el != null && !el.textContent?.includes("No worker running")
          },
          undefined,
          { timeout: 15_000 },
        )
        pass("banner absent when healthy")
      } catch {
        fail(
          "banner absent when healthy",
          "banner still reported no worker 15s after one started",
        )
      }

      await killProcessTree(worker)
      worker = null

      const downStart = Date.now()
      let downElapsed = Infinity
      while (Date.now() - downStart < 12_000) {
        const text = await status.innerText()
        if (text.includes("No worker running")) {
          downElapsed = Date.now() - downStart
          break
        }
        await page.waitForTimeout(250)
      }
      if (downElapsed < 10_000) {
        pass("worker down surfaces within 10s", `${downElapsed}ms`)
        if (downElapsed > 8_500) {
          console.warn(`WARN  worker down measured ${downElapsed}ms (>8500ms)`)
        }
      } else {
        fail("worker down surfaces within 10s", `${downElapsed}ms`)
      }
    } finally {
      if (worker) await killProcessTree(worker)
    }

    const leadLinks = page.locator('a[href*="/leads?lead="]')
    const hrefs = await leadLinks.evaluateAll((anchors) =>
      anchors.map((anchor) => anchor.getAttribute("href") ?? ""),
    )
    const bad = hrefs.filter((href) => {
      const id = new URL(href, UI_BASE_URL).searchParams.get("lead")
      return id != null && !UUID_RE.test(id)
    })
    if (hrefs.length > 0 && bad.length === 0) {
      pass("lead links use the campaign_lead id")
    } else if (hrefs.length === 0) {
      skip("lead links use the campaign_lead id", "no lead links on page")
    } else {
      fail("lead links use the campaign_lead id", bad.join(", "))
    }

    tracker.stop()
  } finally {
    await browser.close()
    await removeJobsThisRunOrphaned(supabase, pendingBefore)
    await closeQueueConnections()
  }

  printUiSummary(results)
  process.exit(process.exitCode ?? 0)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
