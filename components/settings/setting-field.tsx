"use client"

import { useState } from "react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
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
import { Switch } from "@/components/ui/switch"
import type { SettingRow } from "@/lib/settings-admin"
import {
  SETTING_DEFAULTS,
  SETTING_FIELDS,
  type SettingKey,
} from "@/lib/settings-schema"
import { mergeLayoutLabel } from "@/components/leads/lead-labels"

type SettingFieldProps = {
  row: SettingRow
  value: string
  onChange: (value: string) => void
  onReset: () => void
  fieldError?: string
}

export function SettingField({
  row,
  value,
  onChange,
  onReset,
  fieldError,
}: SettingFieldProps) {
  const meta = SETTING_FIELDS[row.key]
  const [dryRunConfirmOpen, setDryRunConfirmOpen] = useState(false)

  return (
    <Field>
      <div className="flex flex-wrap items-center gap-2">
        <FieldLabel htmlFor={row.key}>{meta.label}</FieldLabel>
        <Badge variant="outline">{meta.overrideScope}</Badge>
        {!row.presentInDb ? (
          <Badge variant="secondary">Not in database — using default</Badge>
        ) : null}
        {row.parseState === "unparseable" ? (
          <Badge variant="destructive">Unparseable — pipeline uses default</Badge>
        ) : null}
        {row.parseState === "out_of_range" ? (
          <Badge variant="destructive">Out of range — pipeline uses default</Badge>
        ) : null}
      </div>

      {meta.type === "boolean" ? (
        <>
          <div className="flex items-center gap-3">
            <Switch
              id={row.key}
              name={row.key}
              value="true"
              uncheckedValue="false"
              checked={value === "true"}
              onCheckedChange={(checked) => {
                if (row.key === "deploy.dry_run" && checked) {
                  setDryRunConfirmOpen(true)
                  return
                }
                onChange(checked ? "true" : "false")
              }}
            />
            <span className="text-sm text-muted-foreground">
              {value === "true" ? "On" : "Off"}
            </span>
          </div>
          <DryRunConfirmDialog
            open={dryRunConfirmOpen}
            onOpenChange={setDryRunConfirmOpen}
            onConfirm={() => onChange("true")}
          />
        </>
      ) : meta.type === "enum" ? (
        <>
          <Select
            value={value}
            onValueChange={(next) => next && onChange(next)}
          >
            <SelectTrigger id={row.key} className="w-full max-w-md">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {meta.enumValues?.map((layout) => (
                <SelectItem key={layout} value={layout}>
                  {mergeLayoutLabel(layout)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <input type="hidden" name={row.key} value={value} />
        </>
      ) : (
        <Input
          id={row.key}
          name={row.key}
          type="number"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          min={meta.min}
          max={meta.max}
          step={meta.type === "integer" ? 1 : row.key === "merge.pip_scale" ? 0.01 : "any"}
          className="max-w-md"
          aria-invalid={Boolean(fieldError)}
        />
      )}

      {row.description ? (
        <FieldDescription>{row.description}</FieldDescription>
      ) : null}
      <FieldDescription>
        Default: {formatDefault(row.key, SETTING_DEFAULTS[row.key])}
      </FieldDescription>
      {meta.min != null && meta.max != null ? (
        <FieldDescription>
          Allowed range: {meta.min} – {meta.max}
        </FieldDescription>
      ) : null}
      <FieldError>{fieldError}</FieldError>

      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="mt-1 h-auto px-0 text-xs"
        onClick={onReset}
      >
        Reset to default
      </Button>
    </Field>
  )
}

function formatDefault(key: SettingKey, value: unknown): string {
  if (key === "merge.layout" && typeof value === "string") {
    return mergeLayoutLabel(value as Parameters<typeof mergeLayoutLabel>[0])
  }
  return String(value)
}

function DryRunConfirmDialog({
  open,
  onOpenChange,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Enable deploy dry run?</DialogTitle>
          <DialogDescription>
            The pipeline will run through merge and deploy but skip Netlify uploads.
            Leads will report success without a live URL. A banner will remind you
            while this is on.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              onConfirm()
              onOpenChange(false)
            }}
          >
            Enable dry run
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
