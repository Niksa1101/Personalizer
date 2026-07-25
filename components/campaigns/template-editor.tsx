"use client"

import { useActionState, useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"

import {
  updateCampaignTemplateAction,
  type CampaignActionState,
} from "@/app/(app)/campaigns/actions"
import { Button } from "@/components/ui/button"
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert"
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field"
import { Textarea } from "@/components/ui/textarea"
import {
  sampleValuesFor,
  TEMPLATE_PLACEHOLDERS,
  type SampleLead,
} from "@/lib/landing-template"
import { renderLandingHtml } from "@/lib/landing-page"

type TemplateEditorProps = {
  campaignId: string
  initialTemplate: string
  sampleLead: SampleLead
  ctaType: string | null
  ctaUrl: string | null
  ctaLabel: string | null
}

const initialState: CampaignActionState = {}

export function TemplateEditor({
  campaignId,
  initialTemplate,
  sampleLead,
  ctaType,
  ctaUrl,
  ctaLabel,
}: TemplateEditorProps) {
  const [template, setTemplate] = useState(initialTemplate)
  const [state, formAction, pending] = useActionState(
    updateCampaignTemplateAction.bind(null, campaignId),
    initialState,
  )

  const previewHtml = useMemo(() => {
    const values = sampleValuesFor(sampleLead, {
      cta_url: ctaUrl ?? "",
      cta_label: ctaLabel ?? "",
    })
    return renderLandingHtml(template, values, { cta_type: ctaType })
  }, [template, sampleLead, ctaType, ctaUrl, ctaLabel])

  const wasPending = useRef(false)

  useEffect(() => {
    if (state.error) toast.error(state.error)
    if (wasPending.current && !pending && !state.error && !state.fieldErrors) {
      toast.success("Template saved")
    }
    wasPending.current = pending
  }, [pending, state])

  const handleSubmit = () => {
    if (!template.includes("{{video_url}}")) {
      toast.warning(
        "Template has no {{video_url}} placeholder — recipients will not see a video.",
      )
    }
  }

  return (
    <form action={formAction} className="space-y-4" onSubmit={handleSubmit}>
      <Alert>
        <AlertTitle>Revised default template</AlertTitle>
        <AlertDescription>
          New campaigns use an improved default with poster support, larger tap
          targets, and mobile-first typography. Your stored template is
          unchanged.
        </AlertDescription>
      </Alert>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_240px]">
        <Field>
          <FieldLabel htmlFor="landing_template">HTML template</FieldLabel>
          <Textarea
            id="landing_template"
            name="landing_template"
            value={template}
            onChange={(event) => setTemplate(event.target.value)}
            rows={24}
            className="min-h-80 font-mono text-xs leading-relaxed"
            aria-invalid={Boolean(state.fieldErrors?.landing_template)}
          />
          <FieldError>{state.fieldErrors?.landing_template}</FieldError>
        </Field>

        <aside className="space-y-3 rounded-xl border border-border bg-muted/20 p-4">
          <h3 className="text-sm font-medium">Placeholders</h3>
          <FieldDescription>
            From DB.md §5.1.1. Unknown tokens render empty.
          </FieldDescription>
          <ul className="space-y-1 font-mono text-xs text-muted-foreground">
            {TEMPLATE_PLACEHOLDERS.map((token) => (
              <li key={token}>{`{{${token}}}`}</li>
            ))}
          </ul>
        </aside>
      </div>

      <Field>
        <FieldLabel>Live preview</FieldLabel>
        <FieldDescription>
          Preview uses{" "}
          {sampleLead.ref === "LD-0001" && sampleLead.company === "Acme Plumbing"
            ? "the synthetic sample lead"
            : `lead ${sampleLead.ref}`}
          . Sandboxed — scripts disabled.
        </FieldDescription>
        <iframe
          title="Template preview"
          sandbox=""
          srcDoc={previewHtml}
          className="h-[480px] w-full rounded-xl border border-border bg-background"
        />
      </Field>

      <Button type="submit" disabled={pending}>
        {pending ? "Saving…" : "Save template"}
      </Button>
    </form>
  )
}
