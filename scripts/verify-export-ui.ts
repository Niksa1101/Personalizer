/**
 * Phase 15 UI verification — promote, unpromote, export on /leads.
 */

import { type Browser } from "playwright"
import { createClient } from "@supabase/supabase-js"

import type { Database } from "../lib/database.types"
import { assertEnvOrExit } from "../lib/env-node"
import {
  createUiHarness,
  launchAuthenticatedPage,
  loginSessionCookie,
  printUiSummary,
  probeServer,
  UI_BASE_URL,
} from "./fixtures/ui-harness"

const CHECKS = [
  "bulk promote dialog updates badge",
  "drawer approval note while ready",
  "unpromote clears approval note",
  "drawer previously approved note",
  "export fetch response headers and BOM",
] as const

const { results, pass, fail, skip } = createUiHarness()

function skipAll(reason: string): void {
  for (const name of CHECKS) skip(name, reason)
}

async function main(): Promise<void> {
  const env = assertEnvOrExit()
  const supabase = createClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } },
  )

  if (!(await probeServer())) {
    skipAll("dev server not reachable at 127.0.0.1:3000")
    printUiSummary(results)
    return
  }

  const login = await loginSessionCookie(env.APP_PASSWORD)
  if ("reason" in login) {
    skipAll(login.reason)
    printUiSummary(results)
    return
  }

  const runId = Date.now().toString(36)
  let campaignId: string | null = null
  let browser: Browser | null = null
  const leadIds: string[] = []
  let deployedLeadId: string | null = null
  let deployedRef = ""

  try {
    const { data: campaign, error: campaignError } = await supabase
      .from("campaigns")
      .insert({
        name: `Verify Export UI ${runId}`,
        slug: `verify-export-ui-${runId}`,
        landing_template: "<html></html>",
        merge_layout: "bubble_br",
        pip_scale: 0.2,
        viewport_width: 1920,
        viewport_height: 1080,
        nav_timeout_ms: 120_000,
      })
      .select("id")
      .single()
    if (campaignError || !campaign) {
      skipAll(campaignError?.message ?? "campaign seed failed")
      return
    }
    campaignId = campaign.id

    const { data: lead, error: leadError } = await supabase
      .from("leads")
      .insert({
        company: `Export UI Co ${runId}`,
        domain: `export-ui-${runId}.example.com`,
      })
      .select("id, ref")
      .single()
    if (leadError || !lead) {
      skipAll(leadError?.message ?? "lead seed failed")
      return
    }
    leadIds.push(lead.id)
    deployedRef = lead.ref

    const { data: cl, error: clError } = await supabase
      .from("campaign_leads")
      .insert({
        campaign_id: campaignId,
        lead_id: lead.id,
        slug: `export-ui-${runId}`,
        status: "deployed",
        current_step: "deploy",
        netlify_url: `https://example.com/export-ui-${runId}`,
        deployed_at: new Date().toISOString(),
      })
      .select("id")
      .single()
    if (clError || !cl) {
      skipAll(clError?.message ?? "campaign_lead seed failed")
      return
    }
    deployedLeadId = cl.id

    const launched = await launchAuthenticatedPage(login.cookie)
    browser = launched.browser
    const page = launched.page

    const url = `${UI_BASE_URL}/leads?campaign=${campaignId}&sort=ref&order=asc`
    await page.goto(url, { waitUntil: "domcontentloaded" })
    await page.getByText(deployedRef, { exact: true }).first().waitFor()

    const row = page.getByRole("row").filter({ hasText: deployedRef })
    const statusCell = row.locator('[data-column="status"]')
    const overlay = page.locator('[data-slot="sheet-overlay"]')
    const sheet = page.locator('[data-slot="sheet-content"]')

    async function waitForStatus(label: string, timeout = 15_000): Promise<void> {
      await statusCell.getByText(label, { exact: true }).waitFor({ timeout })
    }

    async function closeDrawer(): Promise<void> {
      await page.keyboard.press("Escape")
      await overlay.first().waitFor({ state: "detached", timeout: 10_000 })
    }

    await page.getByLabel(`Select ${deployedRef}`).click({ timeout: 8_000 })
    await page.getByRole("button", { name: "Promote 1 to Ready" }).first().click({ timeout: 8_000 })

    const promoteDialog = page.locator('[data-slot="dialog-content"]', {
      hasText: "Promote 1 lead to Ready?",
    })
    await promoteDialog.waitFor({ timeout: 8_000 })
    await promoteDialog.getByRole("button", { name: "Promote 1 to Ready" }).click({ timeout: 8_000 })

    let promoted = true
    await waitForStatus("Ready").catch(() => {
      promoted = false
    })
    if (!promoted) fail("bulk promote dialog updates badge", "row badge never reached Ready")
    else pass("bulk promote dialog updates badge")

    await row.getByText(deployedRef, { exact: true }).click({ timeout: 8_000 })
    await page.getByText(/^Approved \(promoted/).waitFor({ timeout: 8_000 })
    pass("drawer approval note while ready")

    await page.getByRole("button", { name: "Return to Deployed" }).click({ timeout: 8_000 })
    await sheet.getByText("Deployed", { exact: true }).waitFor({ timeout: 15_000 })
    const noteGone = (await sheet.getByText(/approved \(promoted/i).count()) === 0
    if (!noteGone) fail("unpromote clears approval note", "note still visible")
    else pass("unpromote clears approval note")

    await sheet.getByRole("button", { name: "Promote to Ready" }).click({ timeout: 15_000 })
    await sheet.getByText("Ready", { exact: true }).waitFor({ timeout: 15_000 })
    await closeDrawer()
    await page.reload({ waitUntil: "domcontentloaded" })
    await waitForStatus("Ready", 10_000)

    await supabase
      .from("campaign_leads")
      .update({ status: "queued" })
      .eq("id", deployedLeadId!)
    await page.reload({ waitUntil: "domcontentloaded" })
    await row.getByText(deployedRef, { exact: true }).click({ timeout: 8_000 })
    let previously = true
    await page
      .getByText(/^Previously approved \(promoted/)
      .waitFor({ timeout: 8_000 })
      .catch(() => {
        previously = false
      })
    if (!previously) {
      fail("drawer previously approved note", "note not visible for a promoted non-ready lead")
    } else {
      pass("drawer previously approved note")
    }
    await closeDrawer()

    await supabase
      .from("campaign_leads")
      .update({ status: "ready" })
      .eq("id", deployedLeadId!)
    await page.reload({ waitUntil: "domcontentloaded" })
    await waitForStatus("Ready", 10_000)

    type ExportCapture = {
      ct: string
      cd: string
      rowCount: string | null
      skippedHeader: string | null
      body: Buffer
    }
    const exportBox: { cap: ExportCapture | null } = { cap: null }

    await page.route("**/api/export**", async (route) => {
      const response = await route.fetch()
      const body = Buffer.from(await response.body())
      exportBox.cap = {
        ct: response.headers()["content-type"] ?? "",
        cd: response.headers()["content-disposition"] ?? "",
        rowCount: response.headers()["x-export-row-count"] ?? null,
        skippedHeader: response.headers()["x-export-skipped"] ?? null,
        body,
      }
      await route.fulfill({ response })
    })

    await page.getByRole("button", { name: /Export .* ready lead/i }).click()
    const deadline = Date.now() + 20_000
    while (!exportBox.cap && Date.now() < deadline) {
      await page.waitForTimeout(100)
    }

    const exportCapture = exportBox.cap
    if (!exportCapture) {
      fail("export fetch response headers and BOM", "no export response captured")
    } else {
      const { ct, cd, rowCount, skippedHeader, body } = exportCapture
      const bomOk =
        body.length >= 3 && body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf
      if (
        !ct.includes("text/csv") ||
        !cd.includes("attachment") ||
        rowCount == null ||
        skippedHeader == null ||
        !bomOk
      ) {
        fail(
          "export fetch response headers and BOM",
          `ct=${ct} cd=${cd} rows=${rowCount} skipped=${skippedHeader} bom=${body.slice(0, 3).toString("hex")} len=${body.length}`,
        )
      } else {
        pass("export fetch response headers and BOM", `rows=${rowCount}`)
      }
    }

    await page.unroute("**/api/export**")
  } catch (error) {
    fail("verify:export-ui unexpected", error instanceof Error ? error.message : String(error))
  } finally {
    await browser?.close().catch(() => undefined)
    if (campaignId) await supabase.from("campaigns").delete().eq("id", campaignId)
    for (const id of leadIds) {
      await supabase.from("leads").delete().eq("id", id)
    }
  }

  for (const name of CHECKS) {
    if (!results.some((r) => r.name === name)) {
      fail(name, "leg never reached — an earlier step threw")
    }
  }
  printUiSummary(results)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
