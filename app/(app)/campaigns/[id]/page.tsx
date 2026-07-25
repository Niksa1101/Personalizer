import { notFound } from "next/navigation"
import { Suspense } from "react"

import { CampaignSettings } from "@/components/campaigns/campaign-settings"
import { CampaignToastHandler } from "@/components/campaigns/campaign-toast"
import {
  firstDeployLocked,
  getCampaign,
  getSampleLeadForCampaign,
  hasBuiltVideos,
  listGeneratedPages,
  listIntroVideos,
} from "@/lib/campaigns"

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const campaign = await getCampaign(id)
  return {
    title: campaign?.name ?? "Campaign",
  }
}

type CampaignDetailPageProps = {
  params: Promise<{ id: string }>
}

export default async function CampaignDetailPage({
  params,
}: CampaignDetailPageProps) {
  const { id } = await params
  const campaign = await getCampaign(id)

  if (!campaign) notFound()

  const [slugLocked, intros, builtVideos, sampleLead, generatedPagesResult] =
    await Promise.all([
      firstDeployLocked(id),
      listIntroVideos(),
      hasBuiltVideos(id),
      getSampleLeadForCampaign(id),
      listGeneratedPages(id),
    ])

  return (
    <div className="flex flex-1 flex-col gap-6 p-6">
      <Suspense fallback={null}>
        <CampaignToastHandler />
      </Suspense>

      <div className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-lg font-semibold tracking-tight">{campaign.name}</h2>
          <span className="font-mono text-xs text-muted-foreground">
            {campaign.ref}
          </span>
        </div>
        {campaign.description ? (
          <p className="text-sm text-muted-foreground">{campaign.description}</p>
        ) : null}
      </div>

      <CampaignSettings
        campaign={campaign}
        slugLocked={slugLocked}
        intros={intros}
        hasBuiltVideos={builtVideos}
        sampleLead={sampleLead}
        generatedPages={generatedPagesResult.pages}
        generatedPagesTotal={generatedPagesResult.totalCount}
      />
    </div>
  )
}
