"use client"

import { useActionState, useState } from "react"
import { toast } from "sonner"

import {
  requeueLeadAction,
  updateLeadAction,
  type LeadActionState,
} from "@/app/(app)/leads/actions"
import { DomainConflictHint } from "@/components/leads/lead-error-block"
import { mergeLayoutLabel } from "@/components/leads/lead-labels"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { MERGE_LAYOUTS } from "@/lib/campaign-types"
import type { LeadDetail } from "@/lib/leads"

type LeadEditFormProps = {
  detail: LeadDetail
  onSaved: () => void
}

export function LeadEditForm({ detail, onSaved }: LeadEditFormProps) {
  const [state, formAction, pending] = useActionState(
    async (_prev: LeadActionState, formData: FormData) => {
      const result = await updateLeadAction(detail.id, _prev, formData)
      if (result.error) toast.error(result.error)
      else if (result.fieldErrors) {
        const first = Object.values(result.fieldErrors)[0]
        if (first) toast.error(first)
      } else {
        toast.success("Lead saved")
        onSaved()
      }
      return result
    },
    {},
  )

  const lead = detail.leads
  const showRequeue = state.saved === true
  const [mergeLayout, setMergeLayout] = useState(detail.merge_layout ?? "")

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="leads_updated_at" value={lead.updated_at} />
      <input type="hidden" name="merge_layout" value={mergeLayout} />

      {detail.otherCampaigns.length > 0 ? (
        <p className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm text-muted-foreground">
          This lead also appears in{" "}
          {detail.otherCampaigns.map((c) => c.name).join(", ")}. Edits apply to
          the shared identity record. Already-generated pages keep their old
          copy until the page step re-runs.
        </p>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="company">Company</Label>
          <Input id="company" name="company" defaultValue={lead.company ?? ""} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="full_name">Full name</Label>
          <Input
            id="full_name"
            name="full_name"
            defaultValue={lead.full_name ?? ""}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="first_name">First name</Label>
          <Input
            id="first_name"
            name="first_name"
            defaultValue={lead.first_name ?? ""}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="last_name">Last name</Label>
          <Input
            id="last_name"
            name="last_name"
            defaultValue={lead.last_name ?? ""}
          />
        </div>
        <div className="space-y-1 sm:col-span-2">
          <Label htmlFor="website_url">Website URL</Label>
          <Input
            id="website_url"
            name="website_url"
            defaultValue={lead.website_url ?? ""}
          />
          {state.fieldErrors?.website_url ? (
            <p className="text-xs text-destructive">
              {state.fieldErrors.website_url}
            </p>
          ) : null}
          <DomainConflictHint conflictRef={state.conflictRef} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="email">Email</Label>
          <Input id="email" name="email" type="email" defaultValue={lead.email ?? ""} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="phone">Phone</Label>
          <Input id="phone" name="phone" defaultValue={lead.phone ?? ""} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="city">City</Label>
          <Input id="city" name="city" defaultValue={lead.city ?? ""} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="state">State</Label>
          <Input id="state" name="state" defaultValue={lead.state ?? ""} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="country">Country</Label>
          <Input id="country" name="country" defaultValue={lead.country ?? ""} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="merge_layout">Merge layout override</Label>
          <Select
            value={mergeLayout}
            onValueChange={(value) => setMergeLayout(value ?? "")}
          >
            <SelectTrigger id="merge_layout" className="w-full">
              <SelectValue placeholder="Campaign default" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="">Campaign default</SelectItem>
              {MERGE_LAYOUTS.map((layout) => (
                <SelectItem key={layout} value={layout}>
                  {mergeLayoutLabel(layout)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="pip_scale">PiP scale override</Label>
          <Input
            id="pip_scale"
            name="pip_scale"
            defaultValue={detail.pip_scale ?? ""}
            placeholder="Campaign default"
          />
          {state.fieldErrors?.pip_scale ? (
            <p className="text-xs text-destructive">
              {state.fieldErrors.pip_scale}
            </p>
          ) : null}
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={pending}>
          Save
        </Button>
        {showRequeue ? (
          <Button
            type="button"
            variant="secondary"
            disabled={pending}
            onClick={async () => {
              const result = await requeueLeadAction(detail.id)
              if (result.error) toast.error(result.error)
              else {
                toast.success("Lead re-queued")
                onSaved()
              }
            }}
          >
            Re-queue this lead
          </Button>
        ) : null}
      </div>
    </form>
  )
}
