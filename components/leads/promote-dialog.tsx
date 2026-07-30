"use client"

import { useMemo, useState } from "react"

import {
  canPromote,
  PROMOTE_SKIP_COPY,
  type PromoteSkipReason,
} from "@/lib/lead-actions"
import type { LeadListRow } from "@/lib/leads"
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

type PromoteDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  selectedRows: LeadListRow[]
  offPageCount: number
  onConfirm: () => Promise<void>
}

function groupExclusions(rows: LeadListRow[]) {
  const counts = new Map<PromoteSkipReason, number>()
  for (const row of rows) {
    const verdict = canPromote({
      status: row.status,
      netlifyUrl: row.netlify_url,
      pageDeployStatus: row.landing_pages?.deploy_status ?? null,
    })
    if (!verdict.ok) {
      counts.set(verdict.reason, (counts.get(verdict.reason) ?? 0) + 1)
    }
  }
  return counts
}

export function PromoteDialog({
  open,
  onOpenChange,
  selectedRows,
  offPageCount,
  onConfirm,
}: PromoteDialogProps) {
  const [busy, setBusy] = useState(false)

  const { eligible, exclusions } = useMemo(() => {
    const eligibleRows = selectedRows.filter((row) =>
      canPromote({
        status: row.status,
        netlifyUrl: row.netlify_url,
        pageDeployStatus: row.landing_pages?.deploy_status ?? null,
      }).ok,
    )
    return {
      eligible: eligibleRows.length,
      exclusions: groupExclusions(selectedRows),
    }
  }, [selectedRows])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            Promote {eligible} lead{eligible === 1 ? "" : "s"} to Ready?
          </DialogTitle>
          <DialogDescription>
            Ready means you have reviewed the landing page and video and approve
            them for outreach export. Promoted leads appear in CSV export.
          </DialogDescription>
        </DialogHeader>

        {exclusions.size > 0 || offPageCount > 0 ? (
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            {[...exclusions.entries()].map(([reason, count]) => (
              <li key={reason}>
                {count} excluded — {PROMOTE_SKIP_COPY[reason]}
              </li>
            ))}
            {offPageCount > 0 ? (
              <li>{offPageCount} selected on other pages — not included</li>
            ) : null}
          </ul>
        ) : null}

        <DialogFooter>
          <DialogClose render={<Button variant="outline" disabled={busy} />}>
            Cancel
          </DialogClose>
          <Button
            disabled={busy || eligible === 0}
            onClick={async () => {
              setBusy(true)
              try {
                await onConfirm()
              } finally {
                setBusy(false)
                onOpenChange(false)
              }
            }}
          >
            Promote {eligible} to Ready
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
