/**
 * Phase 10 landing page DB verification — real Supabase, self-cleaning.
 */

import { randomUUID } from "node:crypto"

import { createClient } from "@supabase/supabase-js"

import {
  getLandingPageForLead,
  listGeneratedPages,
  updateCampaignGeneral,
} from "../lib/campaigns"
import type { Database } from "../lib/database.types"
import { assertEnvOrExit } from "../lib/env-node"
import { DEFAULT_LANDING_TEMPLATE } from "../lib/landing-template"
import { loadPageContext } from "../worker/db"
import { runPageGenerate } from "../worker/page/generate"
import type { StepContext } from "../worker/steps/shared"

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

function stepContext(campaignLeadId: string): StepContext {
  return {
    lead: {
      campaignLead: { id: campaignLeadId },
    } as StepContext["lead"],
    settings: { autoRetryLimit: 0 },
    signal: AbortSignal.timeout(60_000),
    jobRunId: randomUUID(),
  }
}

async function main(): Promise<void> {
  const env = assertEnvOrExit()
  const supabase = createClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } },
  )

  const runId = Date.now().toString(36)
  const campaignSlug = `verify-landing-${runId}`
  const renamedSlug = `${campaignSlug}-renamed`

  let campaignId: string | null = null
  const leadIds: string[] = []
  const campaignLeadIds: string[] = []

  try {
    const { data: campaign, error: campaignError } = await supabase
      .from("campaigns")
      .insert({
        name: `Verify Landing ${runId}`,
        slug: campaignSlug,
        landing_template: DEFAULT_LANDING_TEMPLATE,
        merge_layout: "bubble_br",
        pip_scale: 0.2,
        viewport_width: 1920,
        viewport_height: 1080,
        nav_timeout_ms: 120_000,
        cta_type: "website",
        cta_label: "Book a call",
        cta_url: "https://example.com/book",
      })
      .select("id")
      .single()

    if (campaignError || !campaign) {
      fail("seed campaign", campaignError?.message ?? "insert failed")
      return
    }
    campaignId = campaign.id
    pass("seed campaign")

    async function createLeadWithVideo(
      suffix: string,
      slug: string,
      company: string,
    ): Promise<string> {
      const domain = `verify-landing-${suffix}-${runId}.example.com`
      const { data: lead, error: leadError } = await supabase
        .from("leads")
        .insert({
          company,
          first_name: "Alex",
          full_name: "Alex Example",
          city: "Portland",
          state: "OR",
          domain,
          website_url: `https://${domain}`,
        })
        .select("id")
        .single()

      if (leadError || !lead) {
        throw new Error(leadError?.message ?? "lead insert failed")
      }
      leadIds.push(lead.id)

      const { data: campaignLead, error: clError } = await supabase
        .from("campaign_leads")
        .insert({
          campaign_id: campaignId!,
          lead_id: lead.id,
          slug,
          status: "processing",
          current_step: "page",
        })
        .select("id")
        .single()

      if (clError || !campaignLead) {
        throw new Error(clError?.message ?? "campaign lead insert failed")
      }
      campaignLeadIds.push(campaignLead.id)

      const storageKey = `${randomUUID()}/final.mp4`
      const publicUrl = `${env.NEXT_PUBLIC_SUPABASE_URL.replace(/\/$/, "")}/storage/v1/object/public/lead-videos/${storageKey}`

      const { error: videoError } = await supabase.from("videos").insert({
        campaign_lead_id: campaignLead.id,
        web_storage_key: storageKey,
        web_public_url: publicUrl,
        used_speed_floor: false,
      })

      if (videoError) throw new Error(videoError.message)
      return campaignLead.id
    }

    const primaryLeadId = await createLeadWithVideo("a", "alpha-lead", "Alpha Co")
    pass("seed lead + video")

    const context = await loadPageContext(primaryLeadId)
    if (
      !context?.campaign.slug ||
      !context.lead.company ||
      !context.video?.web_public_url
    ) {
      fail("loadPageContext", "missing expected fields")
    } else {
      pass("loadPageContext")
    }

    const primaryCtx = stepContext(primaryLeadId)
    const firstNote = await runPageGenerate(primaryCtx)

    const { data: pageRow, error: pageError } = await supabase
      .from("landing_pages")
      .select("id, html, content_sha1, path, deploy_status, updated_at")
      .eq("campaign_lead_id", primaryLeadId)
      .single()

    const { data: linkedLead } = await supabase
      .from("campaign_leads")
      .select("landing_page_id")
      .eq("id", primaryLeadId)
      .single()

    if (
      pageError ||
      !pageRow?.html ||
      !pageRow.content_sha1 ||
      !pageRow.path ||
      !linkedLead?.landing_page_id ||
      !firstNote.sha1_changed
    ) {
      fail("runPageGenerate insert", pageError?.message ?? "incomplete row")
    } else {
      pass("runPageGenerate insert", pageRow.path)
    }

    const unchangedSnapshot = pageRow!

    const secondNote = await runPageGenerate(primaryCtx)
    const { data: afterNoChange } = await supabase
      .from("landing_pages")
      .select("content_sha1, deploy_status, updated_at")
      .eq("id", unchangedSnapshot.id)
      .single()

    if (
      secondNote.sha1_changed ||
      afterNoChange?.content_sha1 !== unchangedSnapshot.content_sha1 ||
      afterNoChange?.deploy_status !== unchangedSnapshot.deploy_status ||
      afterNoChange?.updated_at !== unchangedSnapshot.updated_at
    ) {
      fail("upsert no-op on match", "row changed on identical input")
    } else {
      pass("upsert no-op on match")
    }

    await supabase
      .from("landing_pages")
      .update({
        deploy_status: "live",
        unpublished_at: new Date().toISOString(),
      })
      .eq("id", unchangedSnapshot.id)

    await supabase
      .from("campaigns")
      .update({ cta_label: "Changed CTA label" })
      .eq("id", campaignId)

    const changedNote = await runPageGenerate(primaryCtx)
    const { data: afterChange } = await supabase
      .from("landing_pages")
      .select("content_sha1, deploy_status, unpublished_at")
      .eq("id", unchangedSnapshot.id)
      .single()

    if (
      !changedNote.sha1_changed ||
      afterChange?.content_sha1 === unchangedSnapshot.content_sha1 ||
      afterChange?.deploy_status !== "pending" ||
      afterChange?.unpublished_at !== null
    ) {
      fail("deploy reset on content change", JSON.stringify(afterChange))
    } else {
      pass("deploy reset on content change")
    }

    const secondLeadId = await createLeadWithVideo("b", "beta-lead", "Beta Co")
    await runPageGenerate(stepContext(secondLeadId))

    const { data: liveCandidates } = await supabase
      .from("landing_pages")
      .select("id, campaign_leads!landing_pages_campaign_lead_id_fkey!inner(campaign_id)")
      .eq("campaign_leads.campaign_id", campaignId)

    for (const row of liveCandidates ?? []) {
      await supabase
        .from("landing_pages")
        .update({ deploy_status: "live" })
        .eq("id", row.id)
    }

    await updateCampaignGeneral(campaignId, {
      name: `Verify Landing Renamed ${runId}`,
      slug: renamedSlug,
      description: "renamed",
    })

    const { data: renamedPages, error: renamedError } = await supabase
      .from("landing_pages")
      .select(
        "path, deploy_status, campaign_leads!landing_pages_campaign_lead_id_fkey!inner(slug)",
      )
      .eq("campaign_leads.campaign_id", campaignId)

    if (renamedError) {
      fail("update_campaign_general slug rewrite", renamedError.message)
    } else {
      const pathsOk = (renamedPages ?? []).every((row) => {
        const leadSlug = (row.campaign_leads as { slug: string }).slug
        return (
          row.path === `/${renamedSlug}/${leadSlug}` &&
          row.deploy_status === "pending"
        )
      })

      if (!pathsOk || (renamedPages?.length ?? 0) < 2) {
        fail("update_campaign_general slug rewrite", JSON.stringify(renamedPages))
      } else {
        pass("update_campaign_general slug rewrite")
      }
    }

    const { data: beforeNoop } = await supabase
      .from("landing_pages")
      .select("updated_at")
      .eq("id", unchangedSnapshot.id)
      .single()

    await updateCampaignGeneral(campaignId, {
      name: `Verify Landing Renamed ${runId}`,
      slug: renamedSlug,
      description: "renamed again",
    })

    const { data: afterNoop } = await supabase
      .from("landing_pages")
      .select("updated_at")
      .eq("id", unchangedSnapshot.id)
      .single()

    if (afterNoop?.updated_at !== beforeNoop?.updated_at) {
      fail("update_campaign_general no-op", "landing page updated_at changed")
    } else {
      pass("update_campaign_general no-op")
    }

    const thirdLeadId = await createLeadWithVideo("c", "gamma-lead", "Gamma Co")
    await runPageGenerate(stepContext(thirdLeadId))

    const orderedLeadIds = [primaryLeadId, secondLeadId, thirdLeadId]
    for (const [index, leadId] of orderedLeadIds.entries()) {
      await supabase
        .from("campaigns")
        .update({ cta_label: `Order probe ${index}` })
        .eq("id", campaignId)
      await runPageGenerate(stepContext(leadId))
      await new Promise((resolve) => setTimeout(resolve, 100))
    }

    const { pages, totalCount } = await listGeneratedPages(campaignId, 10)
    const timestamps = pages.map((page) => page.updatedAt)
    const sorted = [...timestamps].sort((a, b) => (a > b ? -1 : a < b ? 1 : 0))

    if (
      totalCount < 3 ||
      pages.length < 3 ||
      timestamps.join(",") !== sorted.join(",") ||
      pages[0]?.campaignLeadId !== thirdLeadId
    ) {
      fail(
        "listGeneratedPages order",
        pages.map((page) => `${page.campaignLeadId}:${page.updatedAt}`).join(" | "),
      )
    } else {
      pass("listGeneratedPages order", `${pages.length} pages`)
    }

    const preview = await getLandingPageForLead(primaryLeadId)
    if (!preview?.html || !preview.path || preview.campaignId !== campaignId) {
      fail("getLandingPageForLead", "missing html, path, or campaignId")
    } else {
      pass("getLandingPageForLead")
    }
  } catch (error) {
    fail(
      "verify:landing",
      error instanceof Error ? error.message : String(error),
    )
  } finally {
    if (campaignId) {
      await supabase.from("campaigns").delete().eq("id", campaignId)
    }
    if (leadIds.length > 0) {
      await supabase.from("leads").delete().in("id", leadIds)
    }
  }

  const failed = results.filter((result) => !result.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)

  if (failed.length > 0) {
    process.exit(1)
  }
}

main().catch((error) => {
  console.error("verify:landing fatal:", error)
  process.exit(1)
})
