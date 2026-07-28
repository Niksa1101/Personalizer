"use client"

import { useState } from "react"

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

type DeleteLeadDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: string
  alreadyUnpublished: boolean
  onConfirm: (retain: boolean) => Promise<void>
}

export function DeleteLeadDialog({
  open,
  onOpenChange,
  title,
  description,
  alreadyUnpublished,
  onConfirm,
}: DeleteLeadDialogProps) {
  const [busy, setBusy] = useState(false)
  const [removePages, setRemovePages] = useState(true)

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setRemovePages(true)
        onOpenChange(next)
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        {alreadyUnpublished ? (
          <p className="text-sm text-muted-foreground">
            This page is already unpublished — nothing live will remain on the
            site.
          </p>
        ) : (
          <div className="flex items-start gap-3 py-1">
            <Checkbox
              id="remove-published-page"
              checked={removePages}
              disabled={busy}
              onCheckedChange={(value) => setRemovePages(value === true)}
            />
            <Label htmlFor="remove-published-page" className="leading-snug">
              Also remove the published landing page(s)
            </Label>
          </div>
        )}

        <DialogFooter>
          <DialogClose render={<Button variant="outline" disabled={busy} />}>
            Cancel
          </DialogClose>
          <Button
            variant="destructive"
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              try {
                const retain = alreadyUnpublished ? false : !removePages
                await onConfirm(retain)
              } finally {
                setBusy(false)
              }
            }}
          >
            Remove from campaign
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
