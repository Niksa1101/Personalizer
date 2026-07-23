"use client"

import { useState } from "react"
import { toast } from "sonner"

import { deleteIntroAction } from "@/app/(app)/intros/actions"
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

type DeleteIntroDialogProps = {
  intro: { id: string; name: string; campaigns: { id: string; name: string }[] } | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function DeleteIntroDialog({
  intro,
  open,
  onOpenChange,
}: DeleteIntroDialogProps) {
  const [busy, setBusy] = useState(false)
  const inUse = (intro?.campaigns.length ?? 0) > 0

  async function handleDelete() {
    if (!intro || inUse) return
    setBusy(true)
    const result = await deleteIntroAction(intro.id)
    setBusy(false)

    if (result.error) {
      toast.error(result.error)
      return
    }

    toast.success("Intro deleted")
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete {intro?.name}?</DialogTitle>
          <DialogDescription>
            {inUse ? (
              <>
                This intro is used by{" "}
                <strong>{intro?.campaigns.map((c) => c.name).join(", ")}</strong>.
                Deleting it would re-pause those campaigns. Remove it from each
                campaign first.
              </>
            ) : (
              <>
                Permanently deletes the normalized video, poster, and database
                record. This cannot be undone.
              </>
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" disabled={busy} />}>
            {inUse ? "Close" : "Cancel"}
          </DialogClose>
          {!inUse ? (
            <Button variant="destructive" disabled={busy} onClick={handleDelete}>
              Delete intro
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
