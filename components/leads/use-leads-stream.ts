"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { refetchLeadRowsAction } from "@/app/(app)/leads/actions"
import {
  leadStreamScopeKey,
  type LeadFilters,
  type LeadStreamScope,
} from "@/lib/lead-filters"
import type { LeadListRow } from "@/lib/leads"
import type { DashboardConnectivity } from "@/lib/dashboard-connection"
import { SILENCE_MS } from "@/lib/dashboard-connection"
import type { Database } from "@/lib/database.types"
import { formatDateTime } from "@/lib/format"

type PipelineEventRow = Database["public"]["Tables"]["pipeline_events"]["Row"]

const POLL_MS = 5_000
const STREAM_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000]

function buildStreamUrl(scope: LeadStreamScope): string {
  const params = new URLSearchParams()
  if (scope.campaignId) params.set("campaign", scope.campaignId)
  if (scope.includeArchived) params.set("archived", "1")
  const query = params.toString()
  return query ? `/api/stream/leads?${query}` : "/api/stream/leads"
}

export function useLeadsStream(options: {
  scope: LeadStreamScope
  filters: LeadFilters
  rows: LeadListRow[]
  onRowsPatch: (rows: LeadListRow[]) => void
  onFullRefetch: () => void
  openLeadId: string | null
  onDrawerEvent: (event: PipelineEventRow) => void
}) {
  const {
    scope,
    filters,
    rows,
    onRowsPatch,
    onFullRefetch,
    openLeadId,
    onDrawerEvent,
  } = options

  const [connectivity, setConnectivity] =
    useState<DashboardConnectivity>("live")
  const [lastUpdatedAt, setLastUpdatedAt] = useState(new Date().toISOString())
  const [staleIds, setStaleIds] = useState<Set<string>>(() => new Set())
  const [newLeadCount, setNewLeadCount] = useState(0)

  const rowsRef = useRef(rows)
  const filtersRef = useRef(filters)
  const openLeadIdRef = useRef(openLeadId)
  const onRowsPatchRef = useRef(onRowsPatch)
  const onFullRefetchRef = useRef(onFullRefetch)
  const onDrawerEventRef = useRef(onDrawerEvent)

  useEffect(() => {
    rowsRef.current = rows
  }, [rows])

  useEffect(() => {
    filtersRef.current = filters
  }, [filters])

  useEffect(() => {
    openLeadIdRef.current = openLeadId
  }, [openLeadId])

  useEffect(() => {
    onRowsPatchRef.current = onRowsPatch
  }, [onRowsPatch])

  useEffect(() => {
    onFullRefetchRef.current = onFullRefetch
  }, [onFullRefetch])

  useEffect(() => {
    onDrawerEventRef.current = onDrawerEvent
  }, [onDrawerEvent])

  const patchRows = useCallback((patch: LeadListRow[]) => {
    if (patch.length === 0) return
    const byId = new Map(patch.map((row) => [row.id, row]))
    const next = rowsRef.current.map((row) => byId.get(row.id) ?? row)
    onRowsPatchRef.current(next)
    setLastUpdatedAt(new Date().toISOString())
  }, [])

  const refetchVisibleRows = useCallback(async (ids?: string[]) => {
    const visibleIds = ids ?? rowsRef.current.map((row) => row.id)
    if (visibleIds.length === 0) return false

    const fresh = await refetchLeadRowsAction(
      visibleIds,
      filtersRef.current,
    )
    if (fresh.length === 0 && visibleIds.length > 0) {
      return false
    }

    const freshIds = new Set(fresh.map((row) => row.id))

    patchRows(fresh)

    setStaleIds((prev) => {
      const next = new Set(prev)
      for (const id of visibleIds) {
        if (!freshIds.has(id)) next.add(id)
        else next.delete(id)
      }
      return next
    })

    return fresh.length > 0
  }, [patchRows])

  const refetchChangedIds = useCallback(
    async (ids: string[]) => {
      const visible = new Set(rowsRef.current.map((row) => row.id))
      const relevant = ids.filter((id) => visible.has(id))
      if (relevant.length === 0) return
      await refetchVisibleRows(relevant)
    },
    [refetchVisibleRows],
  )

  const clearIndicators = useCallback(() => {
    setStaleIds(new Set())
    setNewLeadCount(0)
  }, [])

  const handleFullRefetch = useCallback(() => {
    clearIndicators()
    onFullRefetchRef.current()
    setLastUpdatedAt(new Date().toISOString())
  }, [clearIndicators])

  const scopeKey = leadStreamScopeKey(scope)

  useEffect(() => {
    let debounceTimer: ReturnType<typeof setTimeout> | null = null
    let pendingIds = new Set<string>()
    let source: EventSource | null = null
    let silenceTimer: ReturnType<typeof setTimeout> | null = null
    let pollTimer: ReturnType<typeof setInterval> | null = null
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    let reconnectAttempt = 0
    let cancelled = false

    const startPolling = () => {
      if (pollTimer) return
      setConnectivity((prev) => (prev === "unreachable" ? prev : "polling"))
      void refetchVisibleRows()
      pollTimer = setInterval(() => {
        void refetchVisibleRows()
      }, POLL_MS)
    }

    const stopPolling = () => {
      if (pollTimer) {
        clearInterval(pollTimer)
        pollTimer = null
      }
    }

    const scheduleReconnect = () => {
      if (cancelled || reconnectTimer) return
      const delay =
        STREAM_BACKOFF_MS[
          Math.min(reconnectAttempt, STREAM_BACKOFF_MS.length - 1)
        ] ?? 10_000
      reconnectAttempt += 1
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null
        connect()
      }, delay)
    }

    const bumpSilence = () => {
      if (silenceTimer) clearTimeout(silenceTimer)
      silenceTimer = setTimeout(() => {
        source?.close()
        source = null
        startPolling()
        scheduleReconnect()
      }, SILENCE_MS)
    }

    const scheduleRefetch = () => {
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => {
        debounceTimer = null
        const ids = [...pendingIds]
        pendingIds = new Set()
        void refetchChangedIds(ids)
      }, 250)
    }

    const connect = () => {
      source?.close()
      source = new EventSource(buildStreamUrl(scope))
      bumpSilence()

      // Recovery is only proven once the socket actually opens. Resetting the
      // backoff (or claiming "live") at construction time makes every failed
      // attempt look like a fresh success, which pins the delay at the first
      // rung and hot-loops against a dead server.
      source.onopen = () => {
        reconnectAttempt = 0
        stopPolling()
        setConnectivity("live")
      }

      source.onmessage = () => bumpSilence()

      source.addEventListener("changed", (event) => {
        bumpSilence()
        const payload = JSON.parse(event.data) as {
          ids?: string[]
          inserted?: string[]
        }
        for (const id of payload.ids ?? []) {
          const visible = rowsRef.current.some((row) => row.id === id)
          if (visible) {
            pendingIds.add(id)
          }
        }
        const insertedCount = payload.inserted?.length ?? 0
        if (insertedCount > 0) {
          setNewLeadCount((count) => count + insertedCount)
        }
        if (pendingIds.size > 0) {
          scheduleRefetch()
        }
      })

      source.addEventListener("resync", () => {
        bumpSilence()
        void refetchVisibleRows()
      })

      source.addEventListener("event", (event) => {
        bumpSilence()
        const row = JSON.parse(event.data) as PipelineEventRow
        const openId = openLeadIdRef.current
        if (openId && row.campaign_lead_id === openId) {
          onDrawerEventRef.current(row)
        }
      })

      source.addEventListener("error", () => {
        setConnectivity("polling")
        source?.close()
        source = null
        startPolling()
        scheduleReconnect()
      })

      source.onerror = () => {
        setConnectivity("polling")
        source?.close()
        source = null
        startPolling()
        scheduleReconnect()
      }
    }

    connect()

    return () => {
      cancelled = true
      if (debounceTimer) clearTimeout(debounceTimer)
      if (silenceTimer) clearTimeout(silenceTimer)
      if (reconnectTimer) clearTimeout(reconnectTimer)
      stopPolling()
      source?.close()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- scopeKey encodes scope
  }, [scopeKey, refetchChangedIds, refetchVisibleRows])

  const lastUpdatedLabel = useMemo(
    () => formatDateTime(lastUpdatedAt),
    [lastUpdatedAt],
  )

  return {
    connectivity,
    lastUpdatedLabel,
    staleIds,
    newLeadCount,
    setNewLeadCount,
    clearIndicators,
    handleFullRefetch,
  }
}
