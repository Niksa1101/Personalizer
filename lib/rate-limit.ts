/**
 * Login throttle. In-memory by design (D12): this is a single-operator tool
 * bound to loopback. A dev-server restart clears every counter — a deliberate
 * escape hatch, not an oversight (D18).
 *
 * The limiter is INVISIBLE to callers: /api/login returns an identical 401 at
 * every tier (D14). Nothing here shapes a response.
 *
 * ONE GLOBAL BUCKET — no per-client keying. This reverses D13, which keyed on
 * `x-forwarded-for` → `x-real-ip` → 'local'. Nothing sits in front of this app
 * (Tech.md §2 — Next binds loopback directly), so those headers are never set
 * by a proxy and are always attacker-supplied: a caller sending a fresh value
 * per request got a fresh bucket per request and the tiers never fired. Since
 * the limiter is the only brute-force control over APP_PASSWORD, a bypassable
 * one is worse than none — it reads as protection that isn't there. One bucket
 * is also the honest model for a tool with exactly one operator.
 */

interface Tier {
  failures: number
  windowMs: number
}

// Evaluated in order; the first satisfied tier locks. (D15)
const TIERS: Tier[] = [
  { failures: 10, windowMs: 15 * 60_000 },
  { failures: 5, windowMs: 60_000 },
]

const LONGEST_WINDOW_MS = Math.max(...TIERS.map((t) => t.windowMs))
const MAX_TRACKED = 32

let failures: number[] = [] // ascending failure timestamps

function sweep(now: number): void {
  failures = failures.filter((t) => now - t < LONGEST_WINDOW_MS)
}

export function isLockedOut(now: number = Date.now()): boolean {
  sweep(now)
  return TIERS.some(
    (tier) => failures.filter((t) => now - t < tier.windowMs).length >= tier.failures,
  )
}

/** Call ONLY for a failure that was actually evaluated. An attempt made while
 *  already locked out must not extend the lockout, or it could never decay (D16). */
export function recordFailure(now: number = Date.now()): void {
  sweep(now)
  failures.push(now)
  failures = failures.slice(-MAX_TRACKED)
}

/** A successful, non-locked-out login clears the record (D17). */
export function clearFailures(): void {
  failures = []
}

/** Test-only. */
export function resetRateLimiter(): void {
  failures = []
}
