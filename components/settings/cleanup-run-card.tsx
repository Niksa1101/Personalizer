"use client"

import { useTransition } from "react"
import { toast } from "sonner"

import { runCleanupNowAction } from "@/app/(app)/settings/actions"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import type { CleanupRunSummary } from "@/lib/cleanup-state"

type CleanupRunCardProps = {
  lastRun: CleanupRunSummary | null
}

function formatAge(iso: string | null): string {
  if (!iso) return "never"
  const ms = Date.now() - Date.parse(iso)
  if (ms < 60_000) return "just now"
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours} h ago`
  const days = Math.floor(hours / 24)
  return `${days} day${days === 1 ? "" : "s"} ago`
}

function attemptDetail(run: CleanupRunSummary): string | null {
  if (run.skipped === "disabled") return "skipped, disabled"
  if (run.skipped === "locked") return "skipped, locked"
  if (!run.ok) return "failed"
  if (run.dryRun) return "dry run"
  return null
}

export function CleanupRunCard({ lastRun }: CleanupRunCardProps) {
  const [pending, startTransition] = useTransition()

  const successAge = formatAge(lastRun?.lastSuccessAt ?? null)
  const lastAttemptAge = lastRun ? formatAge(lastRun.finishedAt) : null
  const secondary =
    lastRun && lastAttemptAge && lastRun.lastSuccessAt !== lastRun.finishedAt
      ? attemptDetail(lastRun)
      : null

  function handleRunNow() {
    startTransition(async () => {
      const result = await runCleanupNowAction()
      if (result.ok) toast.success(result.message)
      else toast.error(result.message)
    })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Cleanup</CardTitle>
        <CardDescription>
          Daily retention sweep for recordings, local web copies, and debug
          screenshots.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <p className="text-sm font-medium">
            Last successful cleanup{" "}
            <span className="text-foreground">{successAge}</span>
          </p>
          {secondary && lastAttemptAge ? (
            <p className="text-sm text-muted-foreground">
              Last run {lastAttemptAge} — {secondary}
            </p>
          ) : null}
        </div>
        <Button type="button" disabled={pending} onClick={handleRunNow}>
          {pending ? "Queueing…" : "Run cleanup now"}
        </Button>
      </CardContent>
    </Card>
  )
}
