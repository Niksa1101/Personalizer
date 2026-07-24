import type { Page } from "playwright"

/** Common CMP container selectors (Tech.md §8.3). */
export const CMP_SELECTORS = [
  "#onetrust-accept-btn-handler",
  "#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll",
  "#CybotCookiebotDialogBodyButtonAccept",
  ".osano-cm-accept-all",
  ".qc-cmp2-summary-buttons button[mode='primary']",
  "#didomi-notice-agree-button",
  "[data-testid='accept-all']",
  "#termly-code-snippet-support button.t-acceptAll",
  ".termly-styles-module-root button.t-acceptAll",
] as const

const ACCEPT_NAME_REGEX =
  /^(accept|allow|agree|got it|ok|i understand)/i

async function clickFirstVisible(
  page: Page,
  selector: string,
): Promise<boolean> {
  const locator = page.locator(selector).first()
  try {
    if ((await locator.count()) === 0) return false
    if (!(await locator.isVisible())) return false
    await locator.click({ timeout: 500 })
    return true
  } catch {
    return false
  }
}

async function clickAccessibleAccept(page: Page, end: number): Promise<boolean> {
  try {
    const bannerRoot = page.locator(
      "[id*='cookie' i], [class*='cookie' i], [id*='consent' i], [class*='consent' i], [id*='onetrust' i], [id*='didomi' i], [class*='cmp' i]",
    )
    const scopedButtons = bannerRoot.locator("button, [role='button']")
    const scopedCount = await scopedButtons.count()
    const buttons =
      scopedCount > 0 ? scopedButtons : page.locator("button, [role='button']")
    const count = Math.min(await buttons.count(), 40)

    for (let i = 0; i < count; i++) {
      if (Date.now() >= end) return false

      const button = buttons.nth(i)
      if (!(await button.isVisible())) continue

      const box = await button.boundingBox()
      if (!box) continue

      const viewport = page.viewportSize()
      if (!viewport) continue

      const fixed = await button.evaluate((el) => {
        const style = window.getComputedStyle(el)
        return style.position === "fixed" || style.position === "sticky"
      })
      if (!fixed) continue

      const name =
        (await button.getAttribute("aria-label")) ??
        (await button.innerText()).trim()
      if (!ACCEPT_NAME_REGEX.test(name)) continue

      await button.click({ timeout: 500 })
      return true
    }
  } catch {
    return false
  }

  return false
}

/** Best-effort cookie banner dismissal, capped at 2 seconds total. */
export async function dismissCookieBanner(
  page: Page,
  deadlineMs: number,
): Promise<void> {
  const end = Date.now() + Math.min(deadlineMs, 2000)

  for (const selector of CMP_SELECTORS) {
    if (Date.now() >= end) return
    if (await clickFirstVisible(page, selector)) return
  }

  if (Date.now() < end) {
    await clickAccessibleAccept(page, end)
  }
}
