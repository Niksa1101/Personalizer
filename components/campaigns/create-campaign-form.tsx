"use client"

import { useActionState, useEffect, useState } from "react"
import Link from "next/link"
import { toast } from "sonner"

import {
  createCampaignAction,
  type CampaignActionState,
} from "@/app/(app)/campaigns/actions"
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
import { slugFromName } from "@/lib/slug"

const initialState: CampaignActionState = {}

export function CreateCampaignForm() {
  const [state, formAction, pending] = useActionState(
    createCampaignAction,
    initialState,
  )
  const [name, setName] = useState("")
  const [slug, setSlug] = useState("")
  const [slugTouched, setSlugTouched] = useState(false)

  useEffect(() => {
    if (state.error) toast.error(state.error)
  }, [state.error])

  function handleNameChange(value: string) {
    setName(value)
    if (!slugTouched) {
      setSlug(slugFromName(value))
    }
  }

  return (
    <form action={formAction} className="mx-auto w-full max-w-lg space-y-6">
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="name">Name</FieldLabel>
          <Input
            id="name"
            name="name"
            required
            maxLength={120}
            value={name}
            onChange={(event) => handleNameChange(event.target.value)}
            aria-invalid={Boolean(state.fieldErrors?.name)}
          />
          <FieldError>{state.fieldErrors?.name}</FieldError>
        </Field>

        <Field>
          <FieldLabel htmlFor="slug">Slug</FieldLabel>
          <Input
            id="slug"
            name="slug"
            required
            value={slug}
            onChange={(event) => {
              setSlugTouched(true)
              setSlug(event.target.value)
            }}
            aria-invalid={Boolean(state.fieldErrors?.slug)}
            className="font-mono"
          />
          <FieldDescription>
            Used in landing page URLs. Auto-derived from the name; edit before saving.
          </FieldDescription>
          <FieldError>{state.fieldErrors?.slug}</FieldError>
        </Field>

        <Field>
          <FieldLabel htmlFor="description">Description</FieldLabel>
          <Textarea
            id="description"
            name="description"
            rows={3}
            placeholder="Optional"
          />
          <FieldError>{state.fieldErrors?.description}</FieldError>
        </Field>
      </FieldGroup>

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? "Creating…" : "Create campaign"}
        </Button>
        <Button variant="outline" render={<Link href="/campaigns" />}>
          Cancel
        </Button>
      </div>
    </form>
  )
}
