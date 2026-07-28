"use client"

import { useState } from "react"

import { DeleteLeadDialog } from "@/components/leads/delete-lead-dialog"
import { Button } from "@/components/ui/button"

type BulkActionBarProps = {
  count: number
  onRetry: () => Promise<void>
  onDelete: (retain: boolean) => Promise<void>
  onClear: () => void
}

export function BulkActionBar({
  count,
  onRetry,
  onDelete,
  onClear,
}: BulkActionBarProps) {
  const [busy, setBusy] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)

  if (count === 0) return null

  return (
    <>
      <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/30 px-3 py-2">
        <span className="text-sm font-medium">{count} selected</span>
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            try {
              await onRetry()
            } finally {
              setBusy(false)
            }
          }}
        >
          Retry
        </Button>
        <Button
          size="sm"
          variant="destructive"
          disabled={busy}
          onClick={() => setDeleteOpen(true)}
        >
          Remove from campaign
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={onClear}>
          Clear
        </Button>
      </div>

      <DeleteLeadDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={`Remove ${count} lead${count === 1 ? "" : "s"} from campaign?`}
        description="This removes the selected leads from this campaign. Recordings are kept for other campaigns and re-import."
        alreadyUnpublished={false}
        onConfirm={async (retain) => {
          setBusy(true)
          try {
            await onDelete(retain)
          } finally {
            setBusy(false)
            setDeleteOpen(false)
          }
        }}
      />
    </>
  )
}
