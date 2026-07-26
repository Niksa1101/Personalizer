"use client"

import { useRouter, useSearchParams } from "next/navigation"

import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import type { CampaignListItem } from "@/lib/campaign-types"

type CampaignScopeSelectProps = {
  campaigns: CampaignListItem[]
  campaignId: string | null
  includeArchived: boolean
}

export function CampaignScopeSelect({
  campaigns,
  campaignId,
  includeArchived,
}: CampaignScopeSelectProps) {
  const router = useRouter()
  const searchParams = useSearchParams()

  const activeCampaigns = campaigns.filter((campaign) => !campaign.archived_at)
  const archivedCampaigns = campaigns.filter((campaign) => campaign.archived_at)

  const updateScope = (nextCampaignId: string | null, nextArchived: boolean) => {
    const params = new URLSearchParams(searchParams.toString())
    if (nextCampaignId) {
      params.set("campaign", nextCampaignId)
    } else {
      params.delete("campaign")
    }
    if (nextArchived) {
      params.set("archived", "1")
    } else {
      params.delete("archived")
    }
    const query = params.toString()
    router.replace(query ? `/?${query}` : "/")
  }

  return (
    <div className="flex flex-wrap items-center gap-4">
      <Select
        value={campaignId ?? "all"}
        onValueChange={(value) => {
          updateScope(value === "all" ? null : value, includeArchived)
        }}
      >
        <SelectTrigger className="w-[min(100%,280px)]">
          <SelectValue placeholder="All campaigns" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All campaigns</SelectItem>
          {activeCampaigns.length > 0 ? (
            <SelectGroup>
              <SelectLabel>Campaigns</SelectLabel>
              {activeCampaigns.map((campaign) => (
                <SelectItem key={campaign.id} value={campaign.id}>
                  {campaign.name}
                </SelectItem>
              ))}
            </SelectGroup>
          ) : null}
          {includeArchived && archivedCampaigns.length > 0 ? (
            <SelectGroup>
              <SelectLabel>Archived</SelectLabel>
              {archivedCampaigns.map((campaign) => (
                <SelectItem key={campaign.id} value={campaign.id}>
                  {campaign.name}
                </SelectItem>
              ))}
            </SelectGroup>
          ) : null}
        </SelectContent>
      </Select>

      <div className="flex items-center gap-2">
        <Switch
          id="dashboard-show-archived"
          checked={includeArchived}
          onCheckedChange={(checked) => updateScope(campaignId, checked)}
        />
        <Label htmlFor="dashboard-show-archived" className="text-sm font-normal">
          Show archived
        </Label>
      </div>
    </div>
  )
}
