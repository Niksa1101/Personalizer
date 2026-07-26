"use client"

import { useCallback, useEffect, useState } from "react"

import {
  createDashboardConnection,
  type DashboardConnectivity,
} from "@/lib/dashboard-connection"
import {
  scopeKey,
  type DashboardScope,
  type DashboardSnapshot,
} from "@/lib/dashboard-types"
import { formatDateTime } from "@/lib/format"

export type { DashboardConnectivity }

export function useDashboardStream(
  scope: DashboardScope,
  initialSnapshot: DashboardSnapshot,
) {
  const [snapshot, setSnapshot] = useState(initialSnapshot)
  const [connectivity, setConnectivity] = useState<DashboardConnectivity>("live")
  const [lastUpdatedAt, setLastUpdatedAt] = useState(initialSnapshot.generatedAt)

  const applySnapshot = useCallback((next: DashboardSnapshot) => {
    setSnapshot(next)
    setLastUpdatedAt(next.generatedAt)
  }, [])

  const scopeCacheKey = scopeKey(scope)

  useEffect(() => {
    const connection = createDashboardConnection({
      scope,
      fetchStream: (url, signal) =>
        fetch(url, { signal, cache: "no-store" }),
      fetchSnapshot: async (url) => {
        const response = await fetch(url, { cache: "no-store" })
        if (!response.ok) {
          throw new Error(`Snapshot failed (${response.status})`)
        }
        return (await response.json()) as DashboardSnapshot
      },
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      now: () => Date.now(),
      onSnapshot: applySnapshot,
      onConnectivity: setConnectivity,
      onWarn: (message) => console.warn(message),
      document,
    })

    return () => {
      connection.stop()
    }
    // scopeCacheKey encodes scope; scope object identity must not re-subscribe.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- scopeCacheKey is the stable scope key
  }, [applySnapshot, scopeCacheKey])

  return {
    snapshot,
    connectivity,
    lastUpdatedAt,
    lastUpdatedLabel: formatDateTime(lastUpdatedAt),
    dimmed: connectivity === "unreachable",
  }
}
