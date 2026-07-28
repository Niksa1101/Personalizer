"use client"

import type { ReactNode } from "react"

import type { DashboardConnectivity } from "@/lib/dashboard-connection"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

type ConnectivityIndicatorProps = {
  state: DashboardConnectivity
  lastUpdatedLabel: string
}

export function ConnectivityIndicator({
  state,
  lastUpdatedLabel,
}: ConnectivityIndicatorProps) {
  if (state === "live") {
    return (
      <Badge variant="outline" className="font-normal text-muted-foreground">
        Live
      </Badge>
    )
  }

  if (state === "polling") {
    return (
      <Badge variant="outline" className="font-normal text-muted-foreground">
        Polling
      </Badge>
    )
  }

  return (
    <div className="flex flex-col items-end gap-1 text-right">
      <Badge variant="destructive" className="font-normal">
        Can&apos;t reach the database
      </Badge>
      <span className="text-xs text-muted-foreground">
        Last updated {lastUpdatedLabel}
      </span>
    </div>
  )
}

export function DashboardDimmer({
  dimmed,
  children,
}: {
  dimmed: boolean
  children: ReactNode
}) {
  return (
    <div className={cn(dimmed && "opacity-60 transition-opacity")}>{children}</div>
  )
}
