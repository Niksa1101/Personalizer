"use client"

import { useMemo, useState } from "react"

import { canPromote } from "@/lib/lead-actions"
import type { LeadListRow } from "@/lib/leads"
import { DeleteLeadDialog } from "@/components/leads/delete-lead-dialog"
import { PromoteDialog } from "@/components/leads/promote-dialog"
import { Button } from "@/components/ui/button"

type BulkActionBarProps = {
  selectedCount: number
  selectedRows: LeadListRow[]
  onRetry: () => Promise<void>
  onPromote: (eligibleIds: string[]) => Promise<void>
  onDelete: (retain: boolean) => Promise<void>
  onClear: () => void
}

export function BulkActionBar({
  selectedCount,
  selectedRows,
  onRetry,
  onPromote,
  onDelete,
  onClear,
}: BulkActionBarProps) {
  const [busy, setBusy] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [promoteOpen, setPromoteOpen] = useState(false)

  const count = selectedCount

  const { eligibleRows, eligibleCount } = useMemo(() => {
    const eligible = selectedRows.filter((row) =>
      canPromote({
        status: row.status,
        netlifyUrl: row.netlify_url,
        pageDeployStatus: row.landing_pages?.deploy_status ?? null,
      }).ok,
    )
    return { eligibleRows: eligible, eligibleCount: eligible.length }
  }, [selectedRows])

  if (count === 0) return null

  return (
    <>
      <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/30 px-3 py-2">
        <span className="text-sm font-medium">{count} selected</span>
        <Button
          size="sm"
          variant="default"
          disabled={busy || eligibleCount === 0}
          onClick={() => setPromoteOpen(true)}
        >
          Promote {eligibleCount} to Ready
        </Button>
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

      <PromoteDialog
        open={promoteOpen}
        onOpenChange={setPromoteOpen}
        selectedRows={selectedRows}
        offPageCount={Math.max(0, selectedCount - selectedRows.length)}
        onConfirm={async () => {
          await onPromote(eligibleRows.map((row) => row.id))
        }}
      />

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
