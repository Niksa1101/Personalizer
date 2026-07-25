import { createHash } from "node:crypto"

import {
  deriveCtaHref,
  landingPath,
  renderLandingHtml,
  safeUrl,
} from "@/lib/landing-page"
import { leadToTemplateValues } from "@/lib/landing-template"
import { PipelineStepError } from "@/lib/pipeline-types"

import {
  linkLandingPageToCampaignLead,
  loadPageContext,
  upsertLandingPage,
  writeStepLog,
} from "../db"
import type { StepContext } from "../steps/shared"
import { buildPublicUrl } from "../video/upload"

export type PageStepNote = {
  path: string
  bytes: number
  sha1_changed: boolean
  poster: boolean
  cta_dropped: boolean
}

function detectCtaDropped(
  template: string,
  ctaType: string | null,
  rawCtaUrl: string | null,
): boolean {
  if (!template.includes("{{cta_url}}")) return false
  const derived = deriveCtaHref(ctaType, rawCtaUrl ?? "")
  return safeUrl(derived, { allowContactSchemes: true }) === ""
}

export async function runPageGenerate(ctx: StepContext): Promise<PageStepNote> {
  const campaignLeadId = ctx.lead.campaignLead.id
  const context = await loadPageContext(campaignLeadId)
  if (!context) {
    throw new PipelineStepError("missing_asset", "Campaign lead not found.")
  }

  const webPublicUrl = context.video?.web_public_url
  if (!webPublicUrl) {
    throw new PipelineStepError(
      "missing_asset",
      "Video has no public URL — retry from step:merge to upload the web encode.",
    )
  }

  const posterUrl = context.video?.poster_storage_key
    ? buildPublicUrl(context.video.poster_storage_key)
    : ""

  if (!context.campaign.landing_template.includes("{{video_url}}")) {
    await writeStepLog({
      scope: "deployer",
      level: "warn",
      message: "Landing template has no {{video_url}} placeholder.",
      campaignLeadId,
      jobRunId: ctx.jobRunId,
    })
  }

  const values = leadToTemplateValues(context.lead, {
    video_url: webPublicUrl,
    poster_url: posterUrl,
    cta_url: context.campaign.cta_url ?? "",
    cta_label: context.campaign.cta_label ?? "",
  })

  const html = renderLandingHtml(context.campaign.landing_template, values, {
    cta_type: context.campaign.cta_type,
  })

  const bytes = Buffer.byteLength(html, "utf8")
  const contentSha1 = createHash("sha1").update(html, "utf8").digest("hex")
  const path = landingPath(context.campaign.slug, context.campaignLead.slug)
  const ctaDropped = detectCtaDropped(
    context.campaign.landing_template,
    context.campaign.cta_type,
    context.campaign.cta_url,
  )

  const { id, sha1Changed } = await upsertLandingPage({
    campaignLeadId,
    path,
    html,
    contentSha1,
    existing: context.existingLandingPage,
  })

  await linkLandingPageToCampaignLead(campaignLeadId, id)

  return {
    path,
    bytes,
    sha1_changed: sha1Changed,
    poster: posterUrl.length > 0,
    cta_dropped: ctaDropped,
  }
}
