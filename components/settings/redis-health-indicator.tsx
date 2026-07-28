"use client"

import { Badge } from "@/components/ui/badge"
import { useQueueHealth } from "@/hooks/use-queue-health"

export function RedisHealthIndicator() {
  const { health, connectivity } = useQueueHealth()

  if (!health && connectivity === "unknown") {
    return <Badge variant="secondary">Redis: checking…</Badge>
  }

  if (health?.redis === "down" || connectivity === "unknown") {
    return <Badge variant="destructive">Redis: unreachable</Badge>
  }

  return <Badge variant="default">Redis: connected</Badge>
}
