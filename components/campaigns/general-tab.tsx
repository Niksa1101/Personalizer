"use client"

import { useRouter } from "next/navigation"
import { useActionState, useEffect, useRef, useState } from "react"
import { toast } from "sonner"

import {
  archiveCampaignAction,
  deleteCampaignAction,
  unarchiveCampaignAction,
  updateCampaignGeneralAction,
  type CampaignActionState,
} from "@/app/(app)/campaigns/actions"
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
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import type { CampaignRow } from "@/lib/campaign-types"

type GeneralTabProps = {
  campaign: CampaignRow
  slugLocked: boolean
}

const initialState: CampaignActionState = {}

export function GeneralTab({ campaign, slugLocked }: GeneralTabProps) {
  const router = useRouter()
  const [state, formAction, pending] = useActionState(
    updateCampaignGeneralAction.bind(null, campaign.id),
    initialState,
  )
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const wasPending = useRef(false)

  useEffect(() => {
    if (state.error) toast.error(state.error)
    if (wasPending.current && !pending && !state.error && !state.fieldErrors) {
      toast.success("Changes saved")
    }
    wasPending.current = pending
  }, [pending, state])

  async function handleArchiveToggle() {
    setBusy(true)
    try {
      if (campaign.archived_at) {
        await unarchiveCampaignAction(campaign.id)
        toast.success("Campaign unarchived")
      } else {
        await archiveCampaignAction(campaign.id)
        toast.success("Campaign archived")
      }
      router.refresh()
    } catch {
      toast.error("Could not update campaign")
    } finally {
      setBusy(false)
    }
  }

  async function handleDelete() {
    setBusy(true)
    try {
      await deleteCampaignAction(campaign.id)
    } catch {
      toast.error("Could not delete campaign")
      setBusy(false)
      setDeleteOpen(false)
    }
  }

  return (
    <div className="mx-auto max-w-lg space-y-8">
      <form action={formAction} className="space-y-6">
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="name">Name</FieldLabel>
            <Input
              id="name"
              name="name"
              defaultValue={campaign.name}
              required
              maxLength={120}
              aria-invalid={Boolean(state.fieldErrors?.name)}
            />
            <FieldError>{state.fieldErrors?.name}</FieldError>
          </Field>

          <Field>
            <FieldLabel htmlFor="slug">Slug</FieldLabel>
            <Input
              id="slug"
              name="slug"
              defaultValue={campaign.slug}
              required
              readOnly={slugLocked}
              aria-invalid={Boolean(state.fieldErrors?.slug)}
              className="font-mono"
            />
            {slugLocked ? (
              <FieldDescription>
                Locked after first deploy — this slug appears in published URLs.
              </FieldDescription>
            ) : (
              <FieldDescription>
                Used in landing page paths. Must be unique.
              </FieldDescription>
            )}
            <FieldError>{state.fieldErrors?.slug}</FieldError>
          </Field>

          <Field>
            <FieldLabel htmlFor="description">Description</FieldLabel>
            <Textarea
              id="description"
              name="description"
              rows={3}
              defaultValue={campaign.description ?? ""}
              placeholder="Optional"
            />
            <FieldError>{state.fieldErrors?.description}</FieldError>
          </Field>
        </FieldGroup>

        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save changes"}
        </Button>
      </form>

      <div className="space-y-4 border-t border-border pt-6">
        <h3 className="text-sm font-medium">Campaign actions</h3>
        <div className="flex flex-wrap gap-3">
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={handleArchiveToggle}
          >
            {campaign.archived_at ? "Unarchive" : "Archive"}
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={busy}
            onClick={() => setDeleteOpen(true)}
          >
            Delete
          </Button>
        </div>
      </div>

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {campaign.name}?</DialogTitle>
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
    </div>
  )
}
