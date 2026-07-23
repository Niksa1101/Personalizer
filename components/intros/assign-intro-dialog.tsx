"use client"

import { useState } from "react"
import { toast } from "sonner"

import { assignIntroToCampaignsAction } from "@/app/(app)/intros/actions"
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

  function handleOpenChange(next: boolean) {
    if (next && intro) {
      setSelected(
        campaigns
          .filter((campaign) => campaign.intro_video_id === intro.id)
          .map((campaign) => campaign.id),
      )
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

  async function handleAssign() {
    if (!intro || selected.length === 0) return
    setBusy(true)
    const result = await assignIntroToCampaignsAction(intro.id, selected)
    setBusy(false)

    if (result.error) {
      toast.error(result.error)
      return
    }

    toast.success("Intro assigned to selected campaigns")
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Assign to campaigns</DialogTitle>
          <DialogDescription>
            Set <strong>{intro?.name}</strong> as the intro for each selected
            campaign.
          </DialogDescription>
        </DialogHeader>

        <FieldDescription className="px-0">
          Changing a campaign&apos;s intro does not re-merge videos already
          built; it applies only to leads not yet merged. Assigning an intro
          writes the FK only — resume/enqueue is Phase 7.
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
            disabled={busy || selected.length === 0 || campaigns.length === 0}
            onClick={handleAssign}
          >
            {busy ? "Assigning…" : "Assign intro"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
