"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { MoreHorizontal } from "lucide-react"
import { useState } from "react"

import { formatDate, formatLeadStatusCounts } from "@/components/campaigns/campaign-labels"
import { DeleteCampaignDialog } from "@/components/campaigns/delete-campaign-dialog"
import { useArchiveToggle } from "@/components/campaigns/use-archive-toggle"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import type { CampaignListItem } from "@/lib/campaign-types"

type CampaignsTableProps = {
  campaigns: CampaignListItem[]
}

export function CampaignsTable({ campaigns }: CampaignsTableProps) {
  const [deleteTarget, setDeleteTarget] = useState<CampaignListItem | null>(null)

  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Ref</TableHead>
            <TableHead>Name</TableHead>
            <TableHead>Slug</TableHead>
            <TableHead>Intro</TableHead>
            <TableHead>Leads</TableHead>
            <TableHead>Created</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="w-12">
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {campaigns.map((campaign) => (
            <CampaignTableRow
              key={campaign.id}
              campaign={campaign}
              onDelete={() => setDeleteTarget(campaign)}
            />
          ))}
        </TableBody>
      </Table>

      <DeleteCampaignDialog
        campaign={deleteTarget}
        open={deleteTarget != null}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      />
    </>
  )
}

function CampaignTableRow({
  campaign,
  onDelete,
}: {
  campaign: CampaignListItem
  onDelete: () => void
}) {
  const { busy, toggle } = useArchiveToggle(campaign)

  return (
    <TableRow>
      <TableCell className="font-mono text-xs">{campaign.ref}</TableCell>
      <TableCell className="font-medium">{campaign.name}</TableCell>
      <TableCell className="font-mono text-xs text-muted-foreground">
        {campaign.slug}
      </TableCell>
      <TableCell>
        {campaign.intro_video_id ? (
          <Badge variant="secondary">Assigned</Badge>
        ) : (
          <Badge variant="destructive">No intro</Badge>
        )}
      </TableCell>
      <TableCell className="max-w-48 truncate text-muted-foreground">
        {formatLeadStatusCounts(campaign.statusCounts)}
      </TableCell>
      <TableCell className="text-muted-foreground">
        {formatDate(campaign.created_at)}
      </TableCell>
      <TableCell>
        {campaign.archived_at ? (
          <Badge variant="outline">Archived</Badge>
        ) : (
          <Badge variant="ghost">Active</Badge>
        )}
      </TableCell>
      <TableCell>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button variant="ghost" size="icon-sm" aria-label="Actions" />}
          >
            <MoreHorizontal />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem render={<Link href={`/campaigns/${campaign.id}`} />}>
              Open
            </DropdownMenuItem>
            <DropdownMenuItem disabled={busy} onClick={toggle}>
              {campaign.archived_at ? "Unarchive" : "Archive"}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={onDelete}>
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </TableCell>
    </TableRow>
  )
}

type ShowArchivedToggleProps = {
  showArchived: boolean
}

export function ShowArchivedToggle({ showArchived }: ShowArchivedToggleProps) {
  const router = useRouter()

  return (
    <div className="flex items-center gap-2">
      <Switch
        id="show-archived"
        checked={showArchived}
        onCheckedChange={(checked) => {
          router.push(checked ? "/campaigns?archived=1" : "/campaigns")
        }}
      />
      <Label htmlFor="show-archived" className="text-sm text-muted-foreground">
        Show archived
      </Label>
    </div>
  )
}
