"use client"

import Link from "next/link"
import { useEffect, useState, useTransition } from "react"
import { toast } from "sonner"

import {
  clearQueueAction,
  pausePipelineAction,
  resumePipelineAction,
  updateConcurrencyAction,
} from "@/app/(app)/queue/actions"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Field,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { QUEUE_POLL_MS, useQueueHealth } from "@/hooks/use-queue-health"
import type { ActiveJobHealth, RecentJobRun } from "@/lib/queue-health"

type QueueViewProps = {
  storedConcurrency: number
}

export function QueueView({ storedConcurrency }: QueueViewProps) {
  const { health } = useQueueHealth({ pollMs: QUEUE_POLL_MS, detail: true })
  const [clearOpen, setClearOpen] = useState(false)
  const [pending, startTransition] = useTransition()
  const [concurrencyInput, setConcurrencyInput] = useState(String(storedConcurrency))

  const data = health
  const liveConcurrency = health?.workers[0]?.concurrency

  return (
    <div className="flex flex-1 flex-col gap-6 p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Queue</h1>
          <p className="text-sm text-muted-foreground">
            Pipeline jobs and worker status. Pause stops draining; it does not
            remove queued work.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {data?.pipelinePaused ? (
            <Button
              variant="outline"
              disabled={pending}
              onClick={() =>
                startTransition(async () => {
                  const result = await resumePipelineAction()
                  if (result.error) toast.error(result.error)
                  else toast.success("Queue resumed")
                })
              }
            >
              Resume queue
            </Button>
          ) : (
            <Button
              variant="outline"
              disabled={pending}
              onClick={() =>
                startTransition(async () => {
                  const result = await pausePipelineAction()
                  if (result.error) toast.error(result.error)
                  else toast.success("Queue paused")
                })
              }
            >
              Pause queue
            </Button>
          )}
          <Button
            variant="destructive"
            disabled={pending}
            onClick={() => setClearOpen(true)}
          >
            Clear queue
          </Button>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Queued depth</CardTitle>
            <CardDescription>
              Waiting + delayed
              {data?.pipelinePaused ? " · pipeline paused" : ""}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-semibold tabular-nums">
              {data?.counts.queuedDepth ?? "—"}
            </p>
            {data && data.counts.delayed > 0 ? (
              <p className="text-xs text-muted-foreground">
                {data.counts.delayed} delayed
              </p>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Active jobs</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-semibold tabular-nums">
              {data?.counts.active ?? "—"}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Concurrency</CardTitle>
            <CardDescription>Stored vs live worker setting</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {health?.workers.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Stored: {storedConcurrency} · no worker running
              </p>
            ) : (
              <p className="text-sm">
                Live: {liveConcurrency ?? "—"} · Pending: {storedConcurrency}
              </p>
            )}
            <form
              className="flex gap-2"
              onSubmit={(event) => {
                event.preventDefault()
                startTransition(async () => {
                  const result = await updateConcurrencyAction(concurrencyInput)
                  if (result.error) toast.error(result.error)
                  else toast.success("Concurrency saved")
                })
              }}
            >
              <Field className="gap-1">
                <FieldLabel htmlFor="queue-concurrency" className="sr-only">
                  Concurrency
                </FieldLabel>
                <Input
                  id="queue-concurrency"
                  type="number"
                  min={1}
                  max={4}
                  className="w-20"
                  value={concurrencyInput}
                  onChange={(event) => setConcurrencyInput(event.target.value)}
                />
              </Field>
              <Button type="submit" size="sm" disabled={pending}>
                Save
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Site sync</CardTitle>
          <CardDescription>
            Runs independently while the pipeline is paused
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-4 text-sm">
          <span>Depth: {data?.siteSync.depth ?? "—"}</span>
          <span>Active: {data?.siteSync.active ? "yes" : "idle"}</span>
          <span>Last: {data?.siteSync.lastResult ?? "—"}</span>
        </CardContent>
      </Card>

      <ActiveJobsPanel
        jobs={health?.activeJobs ?? []}
        serverNow={health?.serverNow ?? null}
        loading={!health}
      />

      <RecentRunsPanel title="Recently completed" runs={health?.recentCompleted ?? []} />
      <RecentRunsPanel title="Recently failed" runs={health?.recentFailed ?? []} failed />

      <ClearQueueDialog open={clearOpen} onOpenChange={setClearOpen} pending={pending} />
    </div>
  )
}

function ActiveJobsPanel({
  jobs,
  serverNow,
  loading,
}: {
  jobs: ActiveJobHealth[]
  serverNow: string | null
  loading: boolean
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Active jobs</CardTitle>
      </CardHeader>
      <CardContent>
        {loading && jobs.length === 0 ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : jobs.length === 0 ? (
          <p className="text-sm text-muted-foreground">No active jobs</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Lead</TableHead>
                <TableHead>Step</TableHead>
                <TableHead>Elapsed</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {jobs.map((job) => (
                <ActiveJobRow key={job.jobId} job={job} serverNow={serverNow} />
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  )
}

function ActiveJobRow({
  job,
  serverNow,
}: {
  job: ActiveJobHealth
  serverNow: string | null
}) {
  const [elapsed, setElapsed] = useState(() =>
    formatElapsed(job.startedAt, serverNow),
  )

  useEffect(() => {
    if (!job.startedAt || !serverNow) return
    const offset = Date.parse(serverNow) - Date.now()
    const tick = () => {
      const adjustedNow = Date.now() + offset
      const start = Date.parse(job.startedAt!)
      const seconds = Math.max(0, Math.floor((adjustedNow - start) / 1000))
      setElapsed(formatSeconds(seconds))
    }
    tick()
    const timer = setInterval(tick, 1000)
    return () => clearInterval(timer)
  }, [job.startedAt, serverNow])

  // /logs `lead` param is a ref; /leads `lead` param is a campaign_lead id.
  const leadHref = `/leads?lead=${encodeURIComponent(job.campaignLeadId)}`

  return (
    <TableRow>
      <TableCell>
        {job.leadRef ? (
          <Link href={leadHref} className="underline">
            {job.leadRef}
          </Link>
        ) : (
          job.campaignLeadId.slice(0, 8)
        )}
      </TableCell>
      <TableCell>{job.step ?? "—"}</TableCell>
      <TableCell className="tabular-nums">{elapsed}</TableCell>
      <TableCell>
        {job.stale ? (
          <span className="text-sm text-destructive">
            Worker gone — resumes on next worker start.{" "}
            {job.leadRef ? (
              <Link href={leadHref} className="underline">
                View lead
              </Link>
            ) : null}
          </span>
        ) : (
          <Badge variant="secondary">Running</Badge>
        )}
      </TableCell>
    </TableRow>
  )
}

function RecentRunsPanel({
  title,
  runs,
  failed = false,
}: {
  title: string
  runs: RecentJobRun[]
  failed?: boolean
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {runs.length === 0 ? (
          <p className="text-sm text-muted-foreground">None in recent history</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Lead</TableHead>
                <TableHead>Step</TableHead>
                <TableHead>Duration</TableHead>
                <TableHead>Finished</TableHead>
                {failed ? <TableHead>Error</TableHead> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {runs.map((run) => (
                <TableRow key={run.id}>
                  <TableCell>
                    {run.leadRef ? (
                      <Link
                        href={`/leads?lead=${encodeURIComponent(run.campaignLeadId)}`}
                        className="underline"
                      >
                        {run.leadRef}
                      </Link>
                    ) : (
                      run.campaignLeadId.slice(0, 8)
                    )}
                  </TableCell>
                  <TableCell>{run.step}</TableCell>
                  <TableCell className="tabular-nums text-xs">
                    {runDuration(run.startedAt, run.finishedAt)}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {run.finishedAt
                      ? new Date(run.finishedAt).toLocaleString()
                      : "—"}
                  </TableCell>
                  {failed ? (
                    <TableCell className="max-w-md truncate text-xs">
                      {run.errorCode ?? run.errorDetail ?? "—"}
                      {run.attemptCount != null ? ` · attempt ${run.attemptCount}` : ""}
                    </TableCell>
                  ) : null}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  )
}

function ClearQueueDialog({
  open,
  onOpenChange,
  pending,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  pending: boolean
}) {
  const [clearing, startClear] = useTransition()

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Clear the queue?</DialogTitle>
          <DialogDescription>
            Waiting and delayed jobs will be removed and their leads paused.
            Active jobs are not cleared — they hold locks and run to completion.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={pending || clearing}
            onClick={() => {
              startClear(async () => {
                const result = await clearQueueAction()
                if (result.error) toast.error(result.error)
                else {
                  const detail =
                    result.removedCount != null
                      ? `Removed ${result.removedCount} job(s)${
                          result.pausedLeadCount != null
                            ? `, paused ${result.pausedLeadCount} lead(s)`
                            : ""
                        }`
                      : "Queue cleared"
                  toast.success(detail)
                  onOpenChange(false)
                }
              })
            }}
          >
            Clear queue
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function formatElapsed(startedAt: string | null, serverNow: string | null): string {
  if (!startedAt || !serverNow) return "—"
  const offset = Date.parse(serverNow) - Date.now()
  const adjustedNow = Date.now() + offset
  const seconds = Math.max(0, Math.floor((adjustedNow - Date.parse(startedAt)) / 1000))
  return formatSeconds(seconds)
}

function formatSeconds(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${String(seconds).padStart(2, "0")}`
}

function runDuration(startedAt: string, finishedAt: string | null): string {
  if (!finishedAt) return "—"
  const seconds = Math.max(
    0,
    Math.floor((Date.parse(finishedAt) - Date.parse(startedAt)) / 1000),
  )
  return formatSeconds(seconds)
}
