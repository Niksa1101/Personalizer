/**
 * Phase 14 logs UI verification — Playwright.
 *
 * verify:logs covers what listLogs returns. This covers what the screen says
 * about it: a rejected level or cursor param empties the table, and the user
 * has to be told why rather than being shown "No logs in the last 24 hours".
 */

import { assertEnvOrExit } from "../lib/env-node"
import {
  describeInvalidLogParams,
  parseLogFilters,
  type LogParamNotice,
} from "../lib/log-filters"
import { getSupabaseAdmin } from "../lib/supabase"
import {
  createUiHarness,
  launchAuthenticatedPage,
  loginSessionCookie,
  printUiSummary,
  probeServer,
  UI_BASE_URL,
} from "./fixtures/ui-harness"
import type { Page } from "playwright"

const EMPTY_WINDOW_TEXT = "No logs in the last 24 hours"

function noticeFor(kind: LogParamNotice["kind"]): LogParamNotice {
  // Taken from the same helper the screen renders, so drift between the two
  // fails here instead of going unnoticed.
  const params = kind === "levels" ? { level: "bogus" } : { cursor: "garbage" }
  const notice = describeInvalidLogParams(parseLogFilters(params))[0]
  if (!notice) throw new Error(`no ${kind} notice — the helper stopped flagging it`)
  return notice
}

async function pageText(page: Page): Promise<string> {
  return page.locator("body").innerText()
}

async function rowCount(page: Page): Promise<number> {
  return page.locator("table tbody tr").count()
}

/** Base UI marks a checked box with data-checked, not the `checked` property. */
async function checkboxStates(page: Page): Promise<boolean[]> {
  return page
    .locator('[data-slot="checkbox"]')
    .evaluateAll((els) =>
      els.map(
        (el) =>
          el.getAttribute("data-checked") !== null ||
          el.getAttribute("aria-checked") === "true",
      ),
    )
}

async function paramGone(page: Page, param: string): Promise<boolean> {
  try {
    await page.waitForFunction(
      (name) => !new URL(window.location.href).searchParams.has(name),
      param,
      { timeout: 10_000 },
    )
    return true
  } catch {
    return false
  }
}

/**
 * A missing reset button is a leg failure, not a reason to abandon the run —
 * otherwise one regression hides every leg after it.
 */
async function clickIfPresent(page: Page, name: string): Promise<boolean> {
  try {
    await page.getByRole("button", { name }).click({ timeout: 10_000 })
    return true
  } catch {
    return false
  }
}

async function main(): Promise<void> {
  const { results, pass, fail, skip } = createUiHarness()
  const env = assertEnvOrExit()

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

  const supabase = getSupabaseAdmin()
  const runId = Date.now().toString(36)
  const { data: seeded, error: seedError } = await supabase
    .from("logs")
    .insert({
      level: "info",
      scope: "web",
      message: `verify-logs-ui seed ${runId}`,
    })
    .select("id")
    .single()
  if (seedError || !seeded) {
    throw new Error(`could not seed a log row: ${seedError?.message}`)
  }

  const { browser, page } = await launchAuthenticatedPage(login.cookie)

  try {
    // Baseline. Every later leg asserts the *absence* of the empty-window
    // message, which proves nothing unless the unfiltered screen has rows.
    await page.goto(`${UI_BASE_URL}/logs`, { waitUntil: "domcontentloaded" })
    const baselineRows = await rowCount(page)
    const baselineText = await pageText(page)
    const baselineNoticed = [noticeFor("levels"), noticeFor("cursor")].some(
      (notice) => baselineText.includes(notice.message),
    )
    if (baselineRows > 0 && !baselineNoticed) {
      pass("clean /logs shows rows and no notice", `${baselineRows} rows`)
    } else {
      fail(
        "clean /logs shows rows and no notice",
        `rows=${baselineRows} noticed=${baselineNoticed}`,
      )
    }

    const levelNotice = noticeFor("levels")
    await page.goto(`${UI_BASE_URL}/logs?level=bogus`, {
      waitUntil: "domcontentloaded",
    })
    const bogusText = await pageText(page)

    if (bogusText.includes(levelNotice.message)) {
      pass("rejected level param is explained on screen")
    } else {
      fail("rejected level param is explained on screen", "notice not rendered")
    }

    if (!bogusText.includes(EMPTY_WINDOW_TEXT)) {
      pass("rejected level does not blame the time window")
    } else {
      fail(
        "rejected level does not blame the time window",
        `screen still offers to widen the window`,
      )
    }

    const bogusBoxes = await checkboxStates(page)
    if (bogusBoxes.length > 0 && bogusBoxes.every((checked) => !checked)) {
      pass("rejected levels leave every box unchecked")
    } else {
      fail(
        "rejected levels leave every box unchecked",
        `states=${JSON.stringify(bogusBoxes)}`,
      )
    }

    const levelResetClicked = await clickIfPresent(page, levelNotice.actionLabel)
    if (!levelResetClicked) {
      fail(
        "reset link clears the level param and rows come back",
        `no "${levelNotice.actionLabel}" control on the page`,
      )
    } else if (await paramGone(page, "level")) {
      const recoveredRows = await rowCount(page)
      if (recoveredRows > 0) {
        pass("reset link clears the level param and rows come back")
      } else {
        fail("reset link clears the level param and rows come back", "no rows")
      }
    } else {
      fail(
        "reset link clears the level param and rows come back",
        "level param survived the reset",
      )
    }

    const cursorNotice = noticeFor("cursor")
    await page.goto(`${UI_BASE_URL}/logs?cursor=garbage`, {
      waitUntil: "domcontentloaded",
    })
    const cursorText = await pageText(page)

    if (cursorText.includes(cursorNotice.message)) {
      pass("stale cursor is explained on screen")
    } else {
      fail("stale cursor is explained on screen", "notice not rendered")
    }

    if (!cursorText.includes(EMPTY_WINDOW_TEXT)) {
      pass("stale cursor does not blame the time window")
    } else {
      fail(
        "stale cursor does not blame the time window",
        "screen still offers to widen the window",
      )
    }

    const cursorResetClicked = await clickIfPresent(
      page,
      cursorNotice.actionLabel,
    )
    if (!cursorResetClicked) {
      fail(
        "reset link clears the cursor and rows come back",
        `no "${cursorNotice.actionLabel}" control on the page`,
      )
    } else if (await paramGone(page, "cursor")) {
      const recoveredRows = await rowCount(page)
      if (recoveredRows > 0) {
        pass("reset link clears the cursor and rows come back")
      } else {
        fail("reset link clears the cursor and rows come back", "no rows")
      }
    } else {
      fail(
        "reset link clears the cursor and rows come back",
        "cursor param survived the reset",
      )
    }
  } finally {
    await browser.close()
    await supabase.from("logs").delete().eq("id", seeded.id)
  }

  printUiSummary(results)
  process.exit(process.exitCode ?? 0)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
