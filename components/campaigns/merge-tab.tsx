"use client"

import Link from "next/link"
import { useActionState, useEffect, useRef, useState } from "react"
import { toast } from "sonner"

import {
  updateCampaignMergeAction,
  type CampaignActionState,
} from "@/app/(app)/campaigns/actions"
import { MERGE_LAYOUT_LABELS } from "@/components/campaigns/campaign-labels"
import { PipPreview } from "@/components/campaigns/pip-preview"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Slider } from "@/components/ui/slider"
import type { CampaignRow, IntroVideoOption, MergeLayout } from "@/lib/campaign-types"
import { MERGE_LAYOUTS } from "@/lib/campaign-types"

type MergeTabProps = {
  campaign: CampaignRow
  intros: IntroVideoOption[]
  hasBuiltVideos: boolean
}

const initialState: CampaignActionState = {}

export function MergeTab({ campaign, intros, hasBuiltVideos }: MergeTabProps) {
  const [mergeLayout, setMergeLayout] = useState<MergeLayout>(campaign.merge_layout)
  const [pipScale, setPipScale] = useState(Number(campaign.pip_scale))
  const [introId, setIntroId] = useState(campaign.intro_video_id ?? "none")

  const [state, formAction, pending] = useActionState(
    updateCampaignMergeAction.bind(null, campaign.id),
    initialState,
  )
  const wasPending = useRef(false)

  useEffect(() => {
    if (state.error) toast.error(state.error)
    if (wasPending.current && !pending && !state.error && !state.fieldErrors) {
      toast.success("Merge settings saved")
    }
    wasPending.current = pending
  }, [pending, state])

  const sliderDisabled = mergeLayout === "fullscreen_intro"

  return (
    <form action={formAction} className="mx-auto max-w-2xl space-y-8">
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="intro_video_id">Intro video</FieldLabel>
          {intros.length === 0 ? (
            <>
              <Alert>
                <AlertDescription>
                  No intros yet —{" "}
                  <Link href="/intros" className="underline underline-offset-4">
                    add one in Intro Videos
                  </Link>
                  .
                </AlertDescription>
              </Alert>
              <input type="hidden" name="intro_video_id" value="none" />
            </>
          ) : (
            <>
              <Select
                value={introId}
                onValueChange={(value) => setIntroId(value ?? "none")}
              >
                <SelectTrigger id="intro_video_id" className="w-full">
                  <SelectValue placeholder="Select an intro" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No intro assigned</SelectItem>
                  {intros.map((intro) => (
                    <SelectItem key={intro.id} value={intro.id}>
                      {intro.name} ({Math.round(intro.duration_ms / 1000)}s)
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <input type="hidden" name="intro_video_id" value={introId} />
            </>
          )}
          {hasBuiltVideos ? (
            <FieldDescription>
              Changing the intro does not re-merge videos already built; it applies
              only to leads not yet merged. Assigning an intro writes the FK only —
              resume/enqueue is Phase 7.
            </FieldDescription>
          ) : (
            <FieldDescription>
              Assigning an intro writes the FK only — resume/enqueue is Phase 7.
            </FieldDescription>
          )}
          <FieldError>{state.fieldErrors?.intro_video_id}</FieldError>
        </Field>

        <Field>
          <FieldLabel htmlFor="merge_layout">Merge layout</FieldLabel>
          <Select
            value={mergeLayout}
            onValueChange={(value) => value && setMergeLayout(value as MergeLayout)}
          >
            <SelectTrigger id="merge_layout" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MERGE_LAYOUTS.map((layout) => (
                <SelectItem key={layout} value={layout}>
                  {MERGE_LAYOUT_LABELS[layout]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <input type="hidden" name="merge_layout" value={mergeLayout} />
          <FieldError>{state.fieldErrors?.merge_layout}</FieldError>
        </Field>

        <Field>
          <FieldLabel htmlFor="pip_scale">
            PiP scale{" "}
            <span className="font-mono text-muted-foreground">
              {pipScale.toFixed(2)}
            </span>
          </FieldLabel>
          <Slider
            id="pip_scale"
            min={0.05}
            max={0.6}
            step={0.01}
            value={[pipScale]}
            disabled={sliderDisabled}
            onValueChange={(value) => {
              const next = Array.isArray(value) ? value[0] : value
              if (next != null) setPipScale(next)
            }}
          />
          <input type="hidden" name="pip_scale" value={pipScale} />
          {sliderDisabled ? (
            <FieldDescription>
              PiP scale is disabled for fullscreen intro layout.
            </FieldDescription>
          ) : null}
          <FieldError>{state.fieldErrors?.pip_scale}</FieldError>
        </Field>
      </FieldGroup>

      <PipPreview mergeLayout={mergeLayout} pipScale={pipScale} />

      <Button type="submit" disabled={pending}>
        {pending ? "Saving…" : "Save merge settings"}
      </Button>
    </form>
  )
}
