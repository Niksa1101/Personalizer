"use client"

import { useState } from "react"
import { toast } from "sonner"

import { setIntroCampaignsAction } from "@/app/(app)/intros/actions"
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
import { FieldDescription } from "@/components/ui/field"
import { Label } from "@/components/ui/label"
import type { AssignableCampaign } from "@/lib/intros"

type AssignIntroDialogProps = {
  intro: { id: string; name: string } | null
  campaigns: AssignableCampaign[]
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function AssignIntroDialog({
  intro,
  campaigns,
  open,
  onOpenChange,
}: AssignIntroDialogProps) {
  const [selected, setSelected] = useState<string[]>([])
  const [busy, setBusy] = useState(false)

  const initiallyAssigned =
    intro === null
      ? []
      : campaigns
          .filter((campaign) => campaign.intro_video_id === intro.id)
          .map((campaign) => campaign.id)

  function handleOpenChange(next: boolean) {
    if (next && intro) {
      setSelected(initiallyAssigned)
    }
    onOpenChange(next)
  }

  function toggleCampaign(campaignId: string, checked: boolean) {
    setSelected((current) =>
      checked
        ? [...current, campaignId]
        : current.filter((id) => id !== campaignId),
    )
  }

  async function handleSave() {
    if (!intro) return

    const clearingAll =
      initiallyAssigned.length > 0 && selected.length === 0
    if (
      clearingAll &&
      !window.confirm(
        `Remove "${intro.name}" from all ${initiallyAssigned.length} campaign${initiallyAssigned.length === 1 ? "" : "s"}?`,
      )
    ) {
      return
    }

    setBusy(true)
    const result = await setIntroCampaignsAction(intro.id, selected)
    setBusy(false)

    if (result.error) {
      toast.error(result.error)
      return
    }

    toast.success(
      selected.length === 0
        ? "Intro removed from selected campaigns"
        : "Campaign intro assignments updated",
    )
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Assign to campaigns</DialogTitle>
          <DialogDescription>
            Choose which campaigns use <strong>{intro?.name}</strong> as their
            intro. Checked campaigns get this intro; unchecked ones lose it.
          </DialogDescription>
        </DialogHeader>

        <FieldDescription className="px-0">
          This adds and removes the intro on the campaigns shown here. Changing
          a campaign&apos;s intro does not re-merge videos already built; it
          applies only to leads not yet merged. Resume/enqueue is Phase 7.
        </FieldDescription>

        <div className="max-h-64 space-y-3 overflow-y-auto py-2">
          {campaigns.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No active campaigns available.
            </p>
          ) : (
            campaigns.map((campaign) => {
              const checked = selected.includes(campaign.id)
              return (
                <div key={campaign.id} className="flex items-center gap-3">
                  <Checkbox
                    id={`assign-${campaign.id}`}
                    checked={checked}
                    disabled={busy}
                    onCheckedChange={(value) =>
                      toggleCampaign(campaign.id, value === true)
                    }
                  />
                  <Label htmlFor={`assign-${campaign.id}`} className="flex-1">
                    {campaign.name}
                  </Label>
                </div>
              )
            })
          )}
        </div>

        <DialogFooter>
          <DialogClose render={<Button variant="outline" disabled={busy} />}>
            Cancel
          </DialogClose>
          <Button
            disabled={busy || campaigns.length === 0}
            onClick={handleSave}
          >
            {busy ? "Saving…" : "Save assignments"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
