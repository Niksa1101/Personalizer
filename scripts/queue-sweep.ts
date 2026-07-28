/**
 * Shared queue hygiene for the verify scripts.
 *
 * Retry and re-queue legs enqueue **real** BullMQ jobs, keyed by campaign_lead
 * id — in-process for the direct legs, and on the dev server for the ones driven
 * through HTTP or the browser. Deleting the fixture rows does not remove those
 * jobs, so every run left poisoned entries in `bull:pipeline:wait` pointing at
 * rows that no longer exist, waiting for the next worker to start and fail on
 * them.
 *
 * It stayed invisible for the whole of Phase 13 because Redis was down:
 * `enqueueLead` fails, nothing is enqueued, and there is nothing to leak. The
 * scripts called themselves self-cleaning on the strength of their Postgres
 * teardown alone.
 *
 * Lives here rather than in each script because the safety argument below is
 * subtle enough that two copies would drift.
 */

import type { SupabaseClient } from "@supabase/supabase-js"

import type { Database } from "../lib/database.types"
import { getQueue, getRedis } from "../lib/queue"

type Supabase = SupabaseClient<Database>

/**
 * `getRedis()` is built with `lazyConnect`, so `status` sits at `"wait"` until
 * something issues a command. A passive `status === "ready"` check therefore
 * reports "Redis is down" in any script that never enqueues in-process — which
 * is precisely the case this sweep exists for, since `verify:leads-ui` enqueues
 * through the dev server. Connect, then answer.
 */
async function redisUsable(): Promise<boolean> {
  // Read through a call rather than a local: `status` is a live property, and
  // narrowing it once would tell the compiler it can never read "ready" again.
  const isReady = () => getRedis().status === "ready"
  if (isReady()) return true

  try {
    await getRedis().connect()
  } catch {
    // Either unreachable, or a connect already in flight — the wait below
    // distinguishes the two without guessing.
  }

  const deadline = Date.now() + 3_000
  while (!isReady() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return isReady()
}

/**
 * Ids of every job already parked in the pipeline queue, so the sweep can tell
 * a run's leavings from work that was there first. Empty when Redis is down,
 * which is also exactly when nothing can be enqueued.
 *
 * Call once **before** a run starts.
 */
export async function pendingJobIds(): Promise<Set<string>> {
  if (!(await redisUsable())) return new Set()
  try {
    const jobs = await getQueue().getJobs(["waiting", "delayed", "paused"])
    return new Set(jobs.map((job) => job.id).filter((id): id is string => !!id))
  } catch {
    return new Set()
  }
}

/**
 * Removes the jobs a run orphaned, and only those.
 *
 * Scoped two ways so it can only ever delete garbage. A job goes only if it
 * appeared **during this run** (hence `before` — pre-existing work is never
 * touched) **and** its campaign_lead row is gone, which is the definition of a
 * job the worker could only fail on.
 *
 * **Call strictly after the fixture rows are deleted.** The sweep decides what
 * to drop by asking which campaign_leads still exist, so running it before the
 * teardown sees every fixture row alive and removes nothing. Keying off the
 * fixture campaign ids instead would miss any lead a delete leg removed after
 * its job was enqueued — both mistakes were made on the way to this version.
 */
export async function removeJobsThisRunOrphaned(
  supabase: Supabase,
  before: Set<string>,
): Promise<number> {
  if (!(await redisUsable())) return 0

  const added = [...(await pendingJobIds())].filter((id) => !before.has(id))
  if (added.length === 0) return 0

  const { data: alive, error } = await supabase
    .from("campaign_leads")
    .select("id")
    .in("id", added)
  // Without a definite answer on which rows survived, removing nothing is the
  // safe failure: a stray job costs one failed run, a wrongly deleted one costs
  // real work.
  if (error) return 0

  const aliveIds = new Set((alive ?? []).map((row) => row.id))
  let removed = 0
  for (const id of added) {
    if (aliveIds.has(id)) continue
    try {
      await getQueue().remove(id)
      removed += 1
    } catch {
      // A job that vanished under us needs no removing.
    }
  }
  return removed
}
