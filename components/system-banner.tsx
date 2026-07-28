"use client"

import Link from "next/link"
import { useMemo } from "react"

import { useQueueHealth } from "@/hooks/use-queue-health"
import { cn } from "@/lib/utils"

type BannerKey =
  | "session-expired"
  | "app-unreachable"
  | "redis-down"
  | "no-worker"
  | "pipeline-paused"
  | "stale-active"
  | "dry-run"
  | "none"

function deriveBannerKey(
  health: ReturnType<typeof useQueueHealth>["health"],
  connectivity: ReturnType<typeof useQueueHealth>["connectivity"],
  sessionExpired: boolean,
): BannerKey {
  if (sessionExpired) return "session-expired"
  if (connectivity === "unknown") {
    if (!health) return "app-unreachable"
    return "app-unreachable"
  }
  if (health?.redis === "down") return "redis-down"
  if (!health) return "none"
  if (health.workers.length === 0) return "no-worker"
  if (health.pipelinePaused) return "pipeline-paused"
  if (health.hasStaleActive || health.activeJobs?.some((job) => job.stale)) {
    return "stale-active"
  }
  if (health.dryRun) return "dry-run"
  return "none"
}

const BANNER_COPY: Record<Exclude<BannerKey, "none">, React.ReactNode> = {
  "session-expired": "Session expired — reload to sign in.",
  "app-unreachable": "Can't reach the app — retrying.",
  "redis-down": "Queue state unknown — the app can't reach Redis.",
  "no-worker":
    "No worker running — queued leads will not move. Start it with npm run worker.",
  "pipeline-paused": (
    <>
      Queue paused — leads are waiting.{" "}
      <Link href="/queue" className="underline underline-offset-2">
        Open queue
      </Link>
    </>
  ),
  "stale-active":
    "A job's worker is gone; it will resume on the next worker start.",
  "dry-run":
    "Deploy dry run is on — the pipeline reports success without publishing pages.",
}

export function SystemBanner() {
  const { health, connectivity, sessionExpired } = useQueueHealth()

  const bannerKey = useMemo(
    () => deriveBannerKey(health, connectivity, sessionExpired),
    [health, connectivity, sessionExpired],
  )

  const content = bannerKey === "none" ? null : BANNER_COPY[bannerKey]

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "w-full text-sm",
        content
          ? "border-b border-border bg-muted/60 px-4 py-2 text-foreground"
          : "h-0 overflow-hidden",
      )}
    >
      {content}
    </div>
  )
}
