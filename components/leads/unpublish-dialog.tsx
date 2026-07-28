"use client"

import { useState } from "react"

import { unpublishLeadAction } from "@/app/(app)/leads/actions"
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
import { toast } from "sonner"

type UnpublishDialogProps = {
  campaignLeadId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  isReady: boolean
  onDone: () => void
}

export function UnpublishDialog({
  campaignLeadId,
  open,
  onOpenChange,
  isReady,
  onDone,
}: UnpublishDialogProps) {
  const [busy, setBusy] = useState(false)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Unpublish landing page?</DialogTitle>
          <DialogDescription>
            The URL stays on the lead record but the page will drop off the
            site on the next sync.
            {isReady
              ? " This lead stays Ready — re-publishing returns it as Deployed and needs re-promotion before export."
              : null}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" disabled={busy} />}>
            Cancel
          </DialogClose>
          <Button
            variant="destructive"
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              const result = await unpublishLeadAction(campaignLeadId)
              setBusy(false)
              if (result.error) toast.error(result.error)
              else {
                toast.success("Page unpublished")
                onOpenChange(false)
                onDone()
              }
            }}
          >
            Unpublish
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
