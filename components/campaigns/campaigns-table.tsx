"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { MoreHorizontal } from "lucide-react"
import { toast } from "sonner"

import {
  archiveCampaignAction,
  deleteCampaignAction,
  unarchiveCampaignAction,
} from "@/app/(app)/campaigns/actions"
import { formatDate, formatLeadStatusCounts } from "@/components/campaigns/campaign-labels"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
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
import { useState } from "react"

type CampaignsTableProps = {
  campaigns: CampaignListItem[]
}

export function CampaignsTable({ campaigns }: CampaignsTableProps) {
  const router = useRouter()
  const [deleteTarget, setDeleteTarget] = useState<CampaignListItem | null>(null)
  const [busy, setBusy] = useState(false)

  async function handleArchiveToggle(campaign: CampaignListItem) {
    setBusy(true)
    try {
      if (campaign.archived_at) {
        await unarchiveCampaignAction(campaign.id)
        toast.success("Campaign unarchived")
      } else {
        await archiveCampaignAction(campaign.id)
        toast.success("Campaign archived")
      }
      router.refresh()
    } catch {
      toast.error("Could not update campaign")
    } finally {
      setBusy(false)
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return
    setBusy(true)
    try {
      await deleteCampaignAction(deleteTarget.id)
    } catch {
      toast.error("Could not delete campaign")
      setBusy(false)
      setDeleteTarget(null)
    }
  }

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
            <TableRow key={campaign.id}>
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
                    render={
                      <Button variant="ghost" size="icon-sm" aria-label="Actions" />
                    }
                  >
                    <MoreHorizontal />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem render={<Link href={`/campaigns/${campaign.id}`} />}>
                      Open
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      disabled={busy}
                      onClick={() => handleArchiveToggle(campaign)}
                    >
                      {campaign.archived_at ? "Unarchive" : "Archive"}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      variant="destructive"
                      onClick={() => setDeleteTarget(campaign)}
                    >
                      Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <Dialog open={deleteTarget != null} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {deleteTarget?.name}?</DialogTitle>
            <DialogDescription>
              Also remove the published landing page(s)? This deletes database
              records only — published pages stay live until Phase 11 wires real
              unpublish.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" disabled={busy} />}>
              Cancel
            </DialogClose>
            <Button variant="destructive" disabled={busy} onClick={handleDelete}>
              Delete campaign
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
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
