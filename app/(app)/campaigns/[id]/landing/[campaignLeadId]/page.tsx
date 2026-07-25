import Link from "next/link"
import { notFound } from "next/navigation"

import { LandingPageViewer } from "@/components/campaigns/landing-page-viewer"
import { Button } from "@/components/ui/button"
import {
  Field,
  FieldDescription,
  FieldLabel,
} from "@/components/ui/field"
import { getCampaign, getLandingPageForLead } from "@/lib/campaigns"

type LandingPreviewPageProps = {
  params: Promise<{ id: string; campaignLeadId: string }>
}

export async function generateMetadata({ params }: LandingPreviewPageProps) {
  const { id, campaignLeadId } = await params
  const [campaign, landingPage] = await Promise.all([
    getCampaign(id),
    getLandingPageForLead(campaignLeadId),
  ])

  if (!campaign || !landingPage || landingPage.campaignId !== id) {
    return { title: "Landing preview" }
  }

  return {
    title: `${campaign.name} — ${landingPage.path}`,
  }
}

export default async function LandingPreviewPage({
  params,
}: LandingPreviewPageProps) {
  const { id, campaignLeadId } = await params
  const [campaign, landingPage] = await Promise.all([
    getCampaign(id),
    getLandingPageForLead(campaignLeadId),
  ])

  if (!campaign) {
    notFound()
  }

  if (!landingPage || landingPage.campaignId !== id) {
    return (
      <div className="flex flex-1 flex-col gap-6 p-6">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold tracking-tight">
            Landing page preview
          </h2>
          <p className="text-sm text-muted-foreground">{campaign.name}</p>
        </div>

        <Field className="max-w-lg">
          <FieldLabel>Not generated yet</FieldLabel>
          <FieldDescription>
            This lead does not have a stored landing page. Run the page pipeline
            step to generate one — preview is never rendered on the fly.
          </FieldDescription>
        </Field>

        <Button
          variant="outline"
          render={<Link href={`/campaigns/${id}`} />}
        >
          Back to campaign
        </Button>
      </div>
    )
  }

  return (
    <div className="flex flex-1 flex-col gap-6 p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold tracking-tight">
            Landing page preview
          </h2>
          <p className="text-sm text-muted-foreground">{campaign.name}</p>
        </div>
        <Button
          variant="outline"
          size="sm"
          render={<Link href={`/campaigns/${id}`} />}
        >
          Back to campaign
        </Button>
      </div>

      <LandingPageViewer
        campaignLeadId={campaignLeadId}
        path={landingPage.path}
      />
    </div>
  )
}
