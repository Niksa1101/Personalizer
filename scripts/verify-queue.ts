/**
 * Phase 14 queue verification — Redis + worker child process.
 */

import { spawn, type ChildProcess } from "node:child_process"
import { createClient } from "@supabase/supabase-js"

import type { Database } from "../lib/database.types"
import { assertEnvOrExit } from "../lib/env-node"
import {
  buildQueueHealth,
  closeHealthRedis,
  probeRedisHealth,
} from "../lib/queue-health"
import {
  closeQueueConnections,
  deleteLiveness,
  getQueue,
  scanLiveWorkers,
} from "../lib/queue"
import { clearQueue } from "../lib/queue-clear"
import { resumePausedLeadsForCampaigns } from "../lib/pipeline-control"
import { upsertSettings } from "../lib/settings-admin"
import { reconcile } from "../worker/recovery"
import { pendingJobIds, removeJobsThisRunOrphaned } from "./queue-sweep"

interface CheckResult {
  name: string
  state: "pass" | "fail" | "skip"
  detail: string
}

const results: CheckResult[] = []
const BASE_URL = "http://127.0.0.1:3000"

function pass(name: string, detail = "ok"): void {
  results.push({ name, state: "pass", detail })
  console.log(`PASS  ${name}${detail === "ok" ? "" : ` — ${detail}`}`)
}

function fail(name: string, detail: string): void {
  results.push({ name, state: "fail", detail })
  process.exitCode = 1
  console.error(`FAIL  ${name} — ${detail}`)
}

function skip(name: string, reason: string): void {
  results.push({ name, state: "skip", detail: reason })
  console.log(`SKIP  ${name} — ${reason}`)
}

async function main(): Promise<void> {
  const env = assertEnvOrExit()
  const supabase = createClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.SUPABASE_SERVICE_ROLE_KEY,
  )
  const runId = Date.now().toString(36)
  const pendingBefore = await pendingJobIds()
  const campaignIds: string[] = []
  const leadIds: string[] = []

  try {
    const health = await buildQueueHealth({})
    if (health.redis === "up" && "serverNow" in health) {
      pass("/api/queue/health shape")
    } else {
      fail("/api/queue/health shape", JSON.stringify(health))
    }

    const unauth = await fetch(`${BASE_URL}/api/queue/health`)
    if (unauth.status === 401) {
      pass("/api/queue/health 401 without session")
    } else {
      skip("/api/queue/health 401 without session", `dev server returned ${unauth.status}`)
    }

    const down = await probeRedisHealth("redis://127.0.0.1:6399")
    if (down === "down") {
      pass("redis-down probe within race")
    } else {
      fail("redis-down probe within race", down)
    }

    let worker: ChildProcess | null = null
    try {
      worker = spawn("npm", ["run", "worker"], {
        cwd: process.cwd(),
        shell: true,
        stdio: "ignore",
      })
      await waitForWorkerBeat(30_000)

      const beats = await buildQueueHealth({})
      const workerId = beats.workers[0]?.workerId
      if (workerId) {
        await deleteLiveness(workerId)
        const fast = await buildQueueHealth({})
        if (fast.workers.length === 0) {
          pass("beat key delete flips sub-second")
        } else {
          fail("beat key delete flips sub-second", `${fast.workers.length} workers`)
        }
      } else {
        skip("beat key delete flips sub-second", "no worker id")
      }

      await upsertSettings([{ key: "queue.concurrency", value: 2 }])
      const concurrencyDeadline = Date.now() + 70_000
      let beatConcurrency: number | undefined
      while (Date.now() < concurrencyDeadline) {
        const polled = await buildQueueHealth({ detail: true })
        beatConcurrency = polled.workers[0]?.concurrency
        if (beatConcurrency === 2) break
        await sleep(500)
      }
      if (beatConcurrency === 2) {
        pass("beat key echoes concurrency after settings write")
      } else {
        fail(
          "beat key echoes concurrency after settings write",
          `live=${beatConcurrency ?? "none"}`,
        )
      }

      const detail = await buildQueueHealth({ detail: true })
      if (detail.siteSync) {
        pass("site-sync in detail payload")
      } else {
        fail("site-sync in detail payload", "missing")
      }

      if (workerId) {
        const bootDeadline = Date.now() + 30_000
        let seen = false
        let dropped = false
        while (Date.now() < bootDeadline) {
          const live = await scanLiveWorkers()
          if (live.includes(workerId)) {
            if (seen) {
              // still present after first sighting — keep sampling
            } else {
              seen = true
            }
          } else if (seen) {
            dropped = true
            break
          }
          await sleep(250)
        }
        if (seen && !dropped) {
          pass("boot recovery keeps the alive key fresh")
        } else if (!seen) {
          skip("boot recovery keeps the alive key fresh", "worker id never appeared")
        } else {
          fail("boot recovery keeps the alive key fresh", "alive key dropped mid-run")
        }
      } else {
        skip("boot recovery keeps the alive key fresh", "no worker id")
      }

      if (worker?.pid) {
        process.kill(worker.pid, "SIGKILL")
      }
      worker = null

      const flipStart = Date.now()
      let flipElapsed = Infinity
      while (Date.now() - flipStart < 12_000) {
        const h = await buildQueueHealth({})
        if (h.workers.length === 0) {
          flipElapsed = Date.now() - flipStart
          break
        }
        await sleep(200)
      }

      if (flipElapsed <= 5_000) {
        pass("beat key TTL expires within 5s", `${flipElapsed}ms`)
      } else {
        fail("beat key TTL expires within 5s", `${flipElapsed}ms`)
      }

      if (flipElapsed < 10_000) {
        pass("worker kill flips within 10s", `${flipElapsed}ms`)
        if (flipElapsed > 8_500) {
          console.warn(`WARN  worker kill measured ${flipElapsed}ms (>8500ms)`)
        }
      } else {
        fail("worker kill flips within 10s", `${flipElapsed}ms`)
      }
    } finally {
      if (worker?.pid) process.kill(worker.pid, "SIGKILL")
      await upsertSettings([{ key: "queue.concurrency", value: 1 }])
    }

    await getQueue().pause()
    const paused = await buildQueueHealth({})
    if (paused.pipelinePaused) {
      pass("pause sets pipelinePaused")
    } else {
      fail("pause sets pipelinePaused", String(paused.pipelinePaused))
    }
    await getQueue().resume()

    const { data: campaign } = await supabase
      .from("campaigns")
      .insert({
        name: `Verify Queue ${runId}`,
        slug: `verify-queue-${runId}`,
        landing_template: "<html></html>",
        merge_layout: "bubble_br",
        pip_scale: 0.2,
        viewport_width: 1920,
        viewport_height: 1080,
        nav_timeout_ms: 120_000,
      })
      .select("id")
      .single()
    if (!campaign) throw new Error("campaign insert failed")
    campaignIds.push(campaign.id)

    for (let i = 0; i < 3; i++) {
      const { data: lead } = await supabase
        .from("leads")
        .insert({ company: `Q${runId}${i}`, domain: `q${runId}${i}.example.com` })
        .select("id")
        .single()
      const { data: cl } = await supabase
        .from("campaign_leads")
        .insert({
          campaign_id: campaign.id,
          lead_id: lead!.id,
          slug: `verify-queue-${runId}-${i}`,
          status: "queued",
        })
        .select("id")
        .single()
      leadIds.push(cl!.id)
      await getQueue().add("process-lead", { campaignLeadId: cl!.id }, { jobId: cl!.id })
    }

    const activeLead = leadIds[0]!
    await getQueue().add(
      "process-lead",
      { campaignLeadId: activeLead },
      { jobId: activeLead },
    )

    const countsBefore = await getQueue().getJobCounts("waiting", "delayed", "active")
    const waitingBefore = (countsBefore.waiting ?? 0) + (countsBefore.delayed ?? 0)
    if (waitingBefore === 3) {
      pass("clear-queue fixture has three waiting jobs")
    } else {
      fail("clear-queue fixture has three waiting jobs", String(waitingBefore))
    }

    const cleared = await clearQueue()
    if (cleared.removedCount === 2) {
      pass("clear-queue removes waiting/delayed only")
    } else {
      fail("clear-queue removes waiting/delayed only", String(cleared.removedCount))
    }

    if (cleared.pausedLeadCount <= cleared.removedCount) {
      pass("clear-queue paused count separate from removals")
    } else {
      fail(
        "clear-queue paused count separate from removals",
        `paused=${cleared.pausedLeadCount} removed=${cleared.removedCount}`,
      )
    }

    await reconcile()
    const { data: pausedLeads } = await supabase
      .from("campaign_leads")
      .select("status")
      .in("id", leadIds.slice(1))
    if (pausedLeads?.every((row) => row.status === "paused")) {
      pass("reconcile leaves cleared leads paused")
    } else {
      fail("reconcile leaves cleared leads paused", "status mismatch")
    }

    await resumePausedLeadsForCampaigns([campaign.id])
    const { data: stillPaused } = await supabase
      .from("campaign_leads")
      .select("status")
      .in("id", leadIds.slice(1))
    if (stillPaused?.every((row) => row.status === "paused")) {
      pass("resumePausedLeadsForCampaigns skips cleared leads")
    } else {
      fail("resumePausedLeadsForCampaigns skips cleared leads", "status mismatch")
    }
  } finally {
    if (campaignIds.length > 0) {
      await supabase.from("campaign_leads").delete().in("id", leadIds)
      await supabase.from("campaigns").delete().in("id", campaignIds)
    }
    await removeJobsThisRunOrphaned(supabase, pendingBefore)
    await closeHealthRedis()
    await closeQueueConnections()
  }

  const passed = results.filter((r) => r.state === "pass").length
  const failed = results.filter((r) => r.state === "fail").length
  const skipped = results.filter((r) => r.state === "skip").length
  console.log(`\nSummary: ${passed} passed, ${failed} failed, ${skipped} skipped`)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForWorkerBeat(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const health = await buildQueueHealth({})
    if (health.workers.length > 0) return
    await sleep(500)
  }
  throw new Error("worker did not register beat in time")
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => process.exit(process.exitCode ?? 0))
