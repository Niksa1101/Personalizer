"use client"

import { useActionState, useEffect, useRef, useState } from "react"
import { toast } from "sonner"

import {
  updateCampaignRecorderAction,
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { CampaignRow } from "@/lib/campaign-types"
import { VIEWPORT_PRESETS } from "@/lib/campaign-types"

type RecorderTabProps = {
  campaign: CampaignRow
}

const initialState: CampaignActionState = {}

const CUSTOM_PRESET = "custom"

function presetKey(width: number, height: number): string {
  return `${width}x${height}`
}

function isPresetMatch(width: number, height: number): boolean {
  return VIEWPORT_PRESETS.some(
    (preset) => preset.width === width && preset.height === height,
  )
}

function findPresetKey(width: number, height: number): string {
  const match = VIEWPORT_PRESETS.find(
    (preset) => preset.width === width && preset.height === height,
  )
  return match ? presetKey(match.width, match.height) : CUSTOM_PRESET
}

export function RecorderTab({ campaign }: RecorderTabProps) {
  const initialIsCustom = !isPresetMatch(
    campaign.viewport_width,
    campaign.viewport_height,
  )
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [preset, setPreset] = useState(
    findPresetKey(campaign.viewport_width, campaign.viewport_height),
  )
  const [viewportWidth, setViewportWidth] = useState(campaign.viewport_width)
  const [viewportHeight, setViewportHeight] = useState(campaign.viewport_height)

  const [state, formAction, pending] = useActionState(
    updateCampaignRecorderAction.bind(null, campaign.id),
    initialState,
  )
  const wasPending = useRef(false)

  useEffect(() => {
    if (state.error) toast.error(state.error)
    if (wasPending.current && !pending && !state.error && !state.fieldErrors) {
      toast.success("Recorder settings saved")
    }
    wasPending.current = pending
  }, [pending, state])

  function handlePresetChange(value: string | null) {
    if (!value || value === CUSTOM_PRESET) return
    setPreset(value)
    const matched = VIEWPORT_PRESETS.find(
      (item) => presetKey(item.width, item.height) === value,
    )
    if (matched) {
      setViewportWidth(matched.width)
      setViewportHeight(matched.height)
    }
  }

  return (
    <form action={formAction} className="mx-auto max-w-lg space-y-6">
      <p className="text-sm text-muted-foreground">
        Global defaults apply unless overridden here. Resolution chain: lead → campaign → global.
      </p>

      <details
        open={advancedOpen}
        onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}
        className="rounded-xl border border-border p-4"
      >
        <summary className="cursor-pointer text-sm font-medium">
          Recorder overrides (advanced)
        </summary>

        <div className="mt-4 space-y-6">
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="viewport_preset">Viewport preset</FieldLabel>
              <Select value={preset} onValueChange={handlePresetChange}>
                <SelectTrigger id="viewport_preset" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {VIEWPORT_PRESETS.map((item) => (
                    <SelectItem
                      key={presetKey(item.width, item.height)}
                      value={presetKey(item.width, item.height)}
                    >
                      {item.label} ({item.width}×{item.height})
                    </SelectItem>
                  ))}
                  {initialIsCustom ? (
                    <SelectItem value={CUSTOM_PRESET}>
                      Custom ({campaign.viewport_width}×{campaign.viewport_height})
                    </SelectItem>
                  ) : null}
                </SelectContent>
              </Select>
              <input type="hidden" name="viewport_width" value={viewportWidth} />
              <input type="hidden" name="viewport_height" value={viewportHeight} />
              <FieldError>{state.fieldErrors?.viewport_width}</FieldError>
            </Field>

            <Field>
              <FieldLabel htmlFor="nav_timeout_ms">Navigation timeout (ms)</FieldLabel>
              <Input
                id="nav_timeout_ms"
                name="nav_timeout_ms"
                type="number"
                min={10_000}
                max={600_000}
                step={1000}
                defaultValue={campaign.nav_timeout_ms}
                aria-invalid={Boolean(state.fieldErrors?.nav_timeout_ms)}
              />
              <FieldDescription>Between 10,000 and 600,000 ms.</FieldDescription>
              <FieldError>{state.fieldErrors?.nav_timeout_ms}</FieldError>
            </Field>
          </FieldGroup>
        </div>
      </details>

      <Button type="submit" disabled={pending}>
        {pending ? "Saving…" : "Save recorder settings"}
      </Button>
    </form>
  )
}
