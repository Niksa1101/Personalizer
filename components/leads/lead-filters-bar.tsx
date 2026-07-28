"use client"

import { useRouter } from "next/navigation"
import { useTransition } from "react"

import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import { LEAD_STATUSES } from "@/lib/campaign-types"
import { ERROR_BUCKETS } from "@/lib/pipeline-types"
import { leadsPageHref, type LeadFilters } from "@/lib/lead-filters"
import type { CampaignOption } from "@/lib/leads"
import { statusLabel, errorBucketLabel } from "@/components/leads/lead-labels"

type LeadFiltersBarProps = {
  filters: LeadFilters
  campaigns: CampaignOption[]
  batches: Array<{ id: string; label: string }>
}

export function LeadFiltersBar({
  filters,
  campaigns,
  batches,
}: LeadFiltersBarProps) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  function navigate(overrides: Partial<LeadFilters>) {
    startTransition(() => {
      router.push(leadsPageHref(filters, { ...overrides, page: 1 }))
    })
  }

  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="min-w-[12rem] flex-1 space-y-1">
        <Label htmlFor="lead-search">Search</Label>
        <Input
          id="lead-search"
          defaultValue={filters.search ?? ""}
          placeholder="Company, name, URL, ref…"
          disabled={pending}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              navigate({ search: event.currentTarget.value || undefined })
            }
          }}
        />
      </div>

      <div className="space-y-1">
        <Label>Campaign</Label>
        <Select
          value={filters.campaignId ?? "all"}
          onValueChange={(value) =>
            navigate({
              campaignId: value === "all" ? undefined : value ?? undefined,
              batchId: undefined,
            })
          }
        >
          <SelectTrigger className="w-[12rem]">
            <SelectValue placeholder="All campaigns" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All campaigns</SelectItem>
            {campaigns.map((campaign) => (
              <SelectItem key={campaign.id} value={campaign.id}>
                {campaign.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1">
        <Label>Status</Label>
        <Select
          value={filters.status ?? "all"}
          onValueChange={(value) =>
            navigate({ status: value === "all" ? undefined : (value as typeof filters.status) })
          }
        >
          <SelectTrigger className="w-[10rem]">
            <SelectValue placeholder="All statuses" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            {LEAD_STATUSES.map((status) => (
              <SelectItem key={status} value={status}>
                {statusLabel(status)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1">
        <Label>Bucket</Label>
        <Select
          value={filters.bucket ?? "all"}
          onValueChange={(value) =>
            navigate({ bucket: value === "all" ? undefined : (value as typeof filters.bucket) })
          }
        >
          <SelectTrigger className="w-[10rem]">
            <SelectValue placeholder="All buckets" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All buckets</SelectItem>
            {ERROR_BUCKETS.map((bucket) => (
              <SelectItem key={bucket} value={bucket}>
                {errorBucketLabel(bucket)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {filters.campaignId && batches.length > 0 ? (
        <div className="space-y-1">
          <Label>Batch</Label>
          <Select
            value={filters.batchId ?? "all"}
            onValueChange={(value) =>
              navigate({ batchId: value === "all" ? undefined : value ?? undefined })
            }
          >
            <SelectTrigger className="w-[10rem]">
              <SelectValue placeholder="All batches" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All batches</SelectItem>
              {batches.map((batch) => (
                <SelectItem key={batch.id} value={batch.id}>
                  {batch.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}

      <div className="flex items-center gap-2 pb-2">
        <Switch
          id="include-archived"
          checked={filters.includeArchived}
          onCheckedChange={(checked) =>
            navigate({ includeArchived: checked })
          }
        />
        <Label htmlFor="include-archived">Archived campaigns</Label>
      </div>
    </div>
  )
}
