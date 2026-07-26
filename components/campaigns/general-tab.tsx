"use client"

import { useActionState, useEffect, useRef, useState } from "react"
import { toast } from "sonner"

import {
  updateCampaignGeneralAction,
  type CampaignActionState,
} from "@/app/(app)/campaigns/actions"
import { DeleteCampaignDialog } from "@/components/campaigns/delete-campaign-dialog"
import { useArchiveToggle } from "@/components/campaigns/use-archive-toggle"
import { Button } from "@/components/ui/button"
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
  const [state, formAction, pending] = useActionState(
    updateCampaignGeneralAction.bind(null, campaign.id),
    initialState,
  )
  const [deleteOpen, setDeleteOpen] = useState(false)
  const { busy, toggle } = useArchiveToggle(campaign)
  const wasPending = useRef(false)

  useEffect(() => {
    if (state.error) toast.error(state.error)
    if (wasPending.current && !pending && !state.error && !state.fieldErrors) {
      toast.success("Changes saved")
    }
    wasPending.current = pending
  }, [pending, state])

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
                Locked after first deploy — this slug appears in published URLs,
                including pages kept after a lead was deleted.
              </FieldDescription>
            ) : (
              <FieldDescription>
                Used in landing page paths. Must be unique. Changing the slug
                moves published pages once site sync runs; old URLs will 404,
                including links already in prospect inboxes.
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
          <Button type="button" variant="outline" disabled={busy} onClick={toggle}>
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

      <DeleteCampaignDialog
        campaign={campaign}
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
      />
    </div>
  )
}
