import Link from "next/link"
import { Megaphone, Plus } from "lucide-react"
import { Suspense } from "react"

import { CampaignToastHandler } from "@/components/campaigns/campaign-toast"
import {
  CampaignsTable,
  ShowArchivedToggle,
} from "@/components/campaigns/campaigns-table"
import { EmptyState } from "@/components/empty-state"
import { Button } from "@/components/ui/button"
import { listCampaigns } from "@/lib/campaigns"

export const metadata = {
  title: "Campaigns",
}

type CampaignsPageProps = {
  searchParams: Promise<{ archived?: string; toast?: string }>
}

export default async function CampaignsPage({
  searchParams,
}: CampaignsPageProps) {
  const params = await searchParams
  const showArchived = params.archived === "1"
  const campaigns = await listCampaigns({ includeArchived: showArchived })

  return (
    <div className="flex flex-1 flex-col gap-6 p-6">
      <Suspense fallback={null}>
        <CampaignToastHandler />
      </Suspense>

      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Campaigns</h2>
          <p className="text-sm text-muted-foreground">
            Named containers for intros, merge style, landing templates, and CTAs.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <ShowArchivedToggle showArchived={showArchived} />
          <Button render={<Link href="/campaigns/new" />}>
            <Plus />
            New campaign
          </Button>
        </div>
      </div>

      {campaigns.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center py-12">
          <EmptyState
            icon={<Megaphone />}
            title="Create your first campaign"
            description="A campaign holds one intro video, merge settings, a landing template, and a CTA for a batch of leads."
            action={
              <Button render={<Link href="/campaigns/new" />}>
                Create campaign
              </Button>
            }
          />
        </div>
      ) : (
        <CampaignsTable campaigns={campaigns} />
      )}
    </div>
  )
}
