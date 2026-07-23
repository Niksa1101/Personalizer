"use client"

import { useState } from "react"
import { toast } from "sonner"

import { deleteCampaignAction } from "@/app/(app)/campaigns/actions"
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

type DeleteCampaignDialogProps = {
  campaign: { id: string; name: string } | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function DeleteCampaignDialog({
  campaign,
  open,
  onOpenChange,
}: DeleteCampaignDialogProps) {
  const [busy, setBusy] = useState(false)

  async function handleDelete() {
    if (!campaign) return
    setBusy(true)
    try {
      await deleteCampaignAction(campaign.id)
    } catch {
      toast.error("Could not delete campaign")
      setBusy(false)
      onOpenChange(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete {campaign?.name}?</DialogTitle>
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
  )
}
