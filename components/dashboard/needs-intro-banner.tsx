import Link from "next/link"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import type { DashboardCountsRaw } from "@/lib/dashboard-types"
import { leadsFilterHref } from "@/lib/dashboard-types"

type NeedsIntroBannerProps = {
  campaigns: DashboardCountsRaw["paused_campaigns"]
}

const CAMPAIGN_CAP = 3

export function NeedsIntroBanner({ campaigns }: NeedsIntroBannerProps) {
  if (campaigns.length === 0) return null

  const visible = campaigns.slice(0, CAMPAIGN_CAP)
  const hiddenCount = Math.max(0, campaigns.length - visible.length)

  return (
    <div className="space-y-3">
      {visible.map((campaign) =>
        campaign.intro_assigned ? (
          <Alert key={campaign.campaign_id}>
            <AlertTitle>
              {campaign.campaign_name} still has paused leads
            </AlertTitle>
            <AlertDescription className="space-y-2">
              <p>
                An intro was assigned, but {campaign.paused_count} lead
                {campaign.paused_count === 1 ? "" : "s"} still{" "}
                {campaign.paused_count === 1 ? "is" : "are"} paused on{" "}
                <span className="font-mono">intro_missing</span>.
              </p>
              <Link
                href={leadsFilterHref({
                  campaignId: campaign.campaign_id,
                  status: "paused",
                })}
                className="font-medium underline-offset-4 hover:underline"
              >
                View paused leads
              </Link>
            </AlertDescription>
          </Alert>
        ) : (
          <Alert key={campaign.campaign_id}>
            <AlertTitle>Paused – Needs Intro</AlertTitle>
            <AlertDescription className="space-y-2">
              <p>
                {campaign.campaign_name} has {campaign.paused_count} lead
                {campaign.paused_count === 1 ? "" : "s"} waiting for an intro
                video before merge can continue.
              </p>
              <Link
                href={`/campaigns/${campaign.campaign_id}?tab=merge`}
                className="font-medium underline-offset-4 hover:underline"
              >
                Assign intro for {campaign.campaign_name}
              </Link>
            </AlertDescription>
          </Alert>
        ),
      )}

      {hiddenCount > 0 ? (
        <p className="text-sm text-muted-foreground">+{hiddenCount} more</p>
      ) : null}
    </div>
  )
}
