import "server-only"

import { REQUIRED_ENV_VARS } from "@/lib/env"

export type EnvHealthEntry = {
  name: string
  present: boolean
  informational?: string
}

export function getEnvHealth(): EnvHealthEntry[] {
  const entries: EnvHealthEntry[] = REQUIRED_ENV_VARS.map((name) => ({
    name,
    present: isPresent(process.env[name]),
  }))

  entries.push({
    name: "NEXT_SERVER_ACTIONS_ENCRYPTION_KEY",
    present: isPresent(process.env.NEXT_SERVER_ACTIONS_ENCRYPTION_KEY),
    informational: "production only, not required here",
  })

  return entries
}

function isPresent(raw: string | undefined): boolean {
  if (raw == null) return false
  return raw.trim() !== ""
}
