"use client"

import { useState } from "react"
import { toast } from "sonner"

import { deleteCampaignAction } from "@/app/(app)/campaigns/actions"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"

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
  const [removePages, setRemovePages] = useState(true)

  async function handleDelete() {
    if (!campaign) return
    setBusy(true)
    try {
      await deleteCampaignAction(campaign.id, removePages)
    } catch {
      toast.error("Could not delete campaign")
      setBusy(false)
      onOpenChange(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) setRemovePages(true)
        onOpenChange(nextOpen)
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete {campaign?.name}?</DialogTitle>
          <DialogDescription>
            This permanently deletes the campaign and its database records. If
            the worker is offline, published page changes are queued until it
            runs again.
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-start gap-3 py-1">
          <Checkbox
            id="remove-published-pages"
            checked={removePages}
            disabled={busy}
            onCheckedChange={(value) => setRemovePages(value === true)}
          />
          <Label htmlFor="remove-published-pages" className="leading-snug">
            Also remove the published landing page(s)
          </Label>
        </div>

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
