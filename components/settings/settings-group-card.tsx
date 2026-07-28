"use client"

import { useActionState, useEffect, useRef, useState } from "react"
import { toast } from "sonner"

import {
  updateSettingsGroupAction,
  type SettingsActionState,
} from "@/app/(app)/settings/actions"
import { SettingField } from "@/components/settings/setting-field"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import type { SettingRow } from "@/lib/settings-admin"
import {
  keysForGroup,
  SETTING_DEFAULTS,
  type SettingGroup,
  type SettingKey,
} from "@/lib/settings-schema"

type SettingsGroupCardProps = {
  group: SettingGroup
  rows: SettingRow[]
}

const initialState: SettingsActionState = {}

export function SettingsGroupCard({ group, rows }: SettingsGroupCardProps) {
  const groupKeys = keysForGroup(group)
  const groupRows = rows.filter((row) => groupKeys.includes(row.key))

  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      groupRows.map((row) => [row.key, formatValue(row.key, row.effectiveValue)]),
    ),
  )
  const [dirty, setDirty] = useState(false)

  const [state, formAction, pending] = useActionState(
    updateSettingsGroupAction.bind(null, group),
    initialState,
  )
  const wasPending = useRef(false)

  useEffect(() => {
    if (state.error) toast.error(state.error)
    if (wasPending.current && !pending && !state.error && !state.fieldErrors) {
      toast.success(`${group} settings saved`)
      setDirty(false)
    }
    wasPending.current = pending
  }, [pending, state, group])

  function handleChange(key: SettingKey, value: string) {
    setValues((prev) => ({ ...prev, [key]: value }))
    setDirty(true)
  }

  function handleReset(key: SettingKey) {
    const defaultValue = SETTING_DEFAULTS[key]
    setValues((prev) => ({
      ...prev,
      [key]: formatValue(key, defaultValue),
    }))
    setDirty(true)
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{group}</CardTitle>
        <CardDescription>
          Global defaults for the {group.toLowerCase()} pipeline stage.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form action={formAction} className="space-y-6">
          {groupRows.map((row) => (
            <SettingField
              key={row.key}
              row={row}
              value={values[row.key] ?? formatValue(row.key, row.effectiveValue)}
              onChange={(value) => handleChange(row.key, value)}
              onReset={() => handleReset(row.key)}
              fieldError={state.fieldErrors?.[row.key]}
            />
          ))}

          <Button type="submit" disabled={pending || !dirty}>
            {pending ? "Saving…" : `Save ${group.toLowerCase()} settings`}
          </Button>
        </form>
      </CardContent>
    </Card>
  )
}

function formatValue(key: SettingKey, value: unknown): string {
  if (typeof value === "boolean") return value ? "true" : "false"
  return String(value)
}
