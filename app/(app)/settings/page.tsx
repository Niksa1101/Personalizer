import { CleanupRunCard } from "@/components/settings/cleanup-run-card"
import { EnvHealthCard } from "@/components/settings/env-health-card"
import { RedisHealthIndicator } from "@/components/settings/redis-health-indicator"
import { SettingsGroupCard } from "@/components/settings/settings-group-card"
import { getCleanupLastRun } from "@/lib/cleanup-state"
import { getEnvHealth } from "@/lib/env-health"
import { listSettingRows } from "@/lib/settings-admin"
import { SETTING_GROUPS } from "@/lib/settings-schema"

export const metadata = {
  title: "Settings",
}

export default async function SettingsPage() {
  const [rows, lastCleanup] = await Promise.all([
    listSettingRows(),
    getCleanupLastRun(),
  ])
  const envHealth = getEnvHealth()

  return (
    <div className="flex flex-1 flex-col gap-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">
          Global pipeline defaults. Changes take effect within a few seconds — no
          restart required.
        </p>
      </div>

      <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
        {SETTING_GROUPS.map((group) => (
          <SettingsGroupCard key={group} group={group} rows={rows} />
        ))}
        <CleanupRunCard lastRun={lastCleanup} />
        <EnvHealthCard entries={envHealth} redisIndicator={<RedisHealthIndicator />} />
      </div>
    </div>
  )
}
