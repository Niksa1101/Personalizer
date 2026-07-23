"use client"

import { useActionState, useEffect, useRef } from "react"
import { toast } from "sonner"

import {
  updateCampaignCtaAction,
  type CampaignActionState,
} from "@/app/(app)/campaigns/actions"
import { CTA_TYPE_LABELS } from "@/components/campaigns/campaign-labels"
import { Button } from "@/components/ui/button"
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { CampaignRow } from "@/lib/campaign-types"
import { CTA_TYPES } from "@/lib/campaign-types"
import { useState } from "react"

type CtaTabProps = {
  campaign: CampaignRow
}

const initialState: CampaignActionState = {}

export function CtaTab({ campaign }: CtaTabProps) {
  const [ctaType, setCtaType] = useState(campaign.cta_type ?? "none")
  const [state, formAction, pending] = useActionState(
    updateCampaignCtaAction.bind(null, campaign.id),
    initialState,
  )
  const wasPending = useRef(false)

  useEffect(() => {
    if (state.error) toast.error(state.error)
    if (wasPending.current && !pending && !state.error && !state.fieldErrors) {
      toast.success("CTA saved")
    }
    wasPending.current = pending
  }, [pending, state])

  return (
    <form action={formAction} className="mx-auto max-w-lg space-y-6">
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="cta_type">Type</FieldLabel>
          <Select value={ctaType} onValueChange={(value) => setCtaType(value ?? "none")}>
            <SelectTrigger id="cta_type" className="w-full">
              <SelectValue placeholder="No CTA" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">No CTA</SelectItem>
              {CTA_TYPES.map((type) => (
                <SelectItem key={type} value={type}>
                  {CTA_TYPE_LABELS[type]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <input type="hidden" name="cta_type" value={ctaType} />
          <FieldDescription>
            All CTA fields are optional. When set, type, label, and URL must be provided together.
          </FieldDescription>
          <FieldError>{state.fieldErrors?.cta_type}</FieldError>
        </Field>

        <Field>
          <FieldLabel htmlFor="cta_label">Button label</FieldLabel>
          <Input
            id="cta_label"
            name="cta_label"
            defaultValue={campaign.cta_label ?? ""}
            maxLength={120}
            aria-invalid={Boolean(state.fieldErrors?.cta_label)}
          />
          <FieldError>{state.fieldErrors?.cta_label}</FieldError>
        </Field>

        <Field>
          <FieldLabel htmlFor="cta_url">URL or value</FieldLabel>
          <Input
            id="cta_url"
            name="cta_url"
            defaultValue={campaign.cta_url ?? ""}
            aria-invalid={Boolean(state.fieldErrors?.cta_url)}
          />
          <FieldDescription>
            Validated by type: email → address/mailto, phone → number/tel, website/calendar → URL.
          </FieldDescription>
          <FieldError>{state.fieldErrors?.cta_url}</FieldError>
        </Field>
      </FieldGroup>

      <Button type="submit" disabled={pending}>
        {pending ? "Saving…" : "Save CTA"}
      </Button>
    </form>
  )
}
