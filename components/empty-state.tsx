"use client"

import type { ReactNode } from "react"

import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"

type PhaseActionProps = {
  label: string
  phase: number
}

export function PhaseAction({ label, phase }: PhaseActionProps) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span tabIndex={0} className="inline-flex cursor-not-allowed" />
        }
      >
        <Button disabled>{label}</Button>
      </TooltipTrigger>
      <TooltipContent>Available in Phase {phase}</TooltipContent>
    </Tooltip>
  )
}

type EmptyStateProps = {
  icon: ReactNode
  title: string
  description: string
  action?: ReactNode
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: EmptyStateProps) {
  return (
    <div className="flex max-w-md flex-col items-center gap-4 text-center">
      <div className="flex size-12 items-center justify-center rounded-xl border border-border bg-muted/40 text-muted-foreground [&_svg]:size-6">
        {icon}
      </div>
      <div className="space-y-2">
        <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      {action ? <div className="pt-1">{action}</div> : null}
    </div>
  )
}
