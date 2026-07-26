import "server-only"

import { enqueueSiteSync } from "@/lib/queue"

/**
 * ioredis reconnects forever by default, so an enqueue against a down Redis
 * neither resolves nor rejects — it hangs, and with it the operator's request.
 * A catch block cannot save you from a promise that never settles, so the wait
 * is bounded here.
 */
const ENQUEUE_TIMEOUT_MS = 3_000

/**
 * Best-effort nudge for the worker to re-sync the Netlify site.
 *
 * Callers must already have written a durable `pending_site_sync` marker inside
 * the same transaction as their change (see the `pending_site_sync` migration).
 * That marker — not this enqueue — is what guarantees the sync happens, so a
 * Redis outage here is logged and swallowed rather than failing or stalling the
 * user's action: boot recovery and the 60s periodic reconcile will pick it up.
 */
export async function requestSiteSync(
  context: Record<string, unknown> = {},
): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  try {
    const landed = await Promise.race([
      enqueueSiteSync(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Redis enqueue timed out after ${ENQUEUE_TIMEOUT_MS}ms`)),
          ENQUEUE_TIMEOUT_MS,
        )
      }),
    ])
    if (!landed) {
      console.warn(
        "[site-sync] enqueue did not land (job locked); pending marker will be drained by reconcile",
        context,
      )
    }
  } catch (error) {
    console.error(
      "[site-sync] enqueue unavailable; pending marker will be drained by reconcile",
      context,
      error instanceof Error ? error.message : error,
    )
  } finally {
    clearTimeout(timer)
  }
}
