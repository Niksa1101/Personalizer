"use client"

import { useActionState, useEffect, useRef, useState } from "react"
import { toast } from "sonner"

import { renameIntroAction, type IntroActionState } from "@/app/(app)/intros/actions"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"

type RenameIntroDialogProps = {
  intro: { id: string; name: string } | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

const initialState: IntroActionState = {}

export function RenameIntroDialog({
  intro,
  open,
  onOpenChange,
}: RenameIntroDialogProps) {
  const [name, setName] = useState(intro?.name ?? "")
  const [state, formAction, pending] = useActionState(
    renameIntroAction,
    initialState,
  )
  const wasPending = useRef(false)

  function handleOpenChange(next: boolean) {
    if (next && intro) setName(intro.name)
    onOpenChange(next)
  }

  useEffect(() => {
    if (state.error) toast.error(state.error)
    if (wasPending.current && !pending && !state.error && !state.fieldErrors) {
      toast.success("Intro renamed")
      onOpenChange(false)
    }
    wasPending.current = pending
  }, [pending, state, onOpenChange])

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <form action={formAction}>
          <DialogHeader>
            <DialogTitle>Rename intro</DialogTitle>
          </DialogHeader>
          <FieldGroup className="py-4">
            <input type="hidden" name="id" value={intro?.id ?? ""} />
            <Field>
              <FieldLabel htmlFor="intro-name">Name</FieldLabel>
              <Input
                id="intro-name"
                name="name"
                value={name}
                maxLength={120}
                disabled={pending}
                onChange={(event) => setName(event.target.value)}
              />
              <FieldError>{state.fieldErrors?.name}</FieldError>
            </Field>
          </FieldGroup>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" disabled={pending} />}>
              Cancel
            </DialogClose>
            <Button type="submit" disabled={pending || !name.trim()}>
              {pending ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
