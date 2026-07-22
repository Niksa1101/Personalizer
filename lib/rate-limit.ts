/**
 * Login throttle. In-memory by design (D12): this is a single-operator tool
 * bound to loopback. A dev-server restart clears every counter — a deliberate
 * escape hatch, not an oversight (D18).
 *
 * The limiter is INVISIBLE to callers: /api/login returns an identical 401 at
 * every tier (D14). Nothing here shapes a response.
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
const MAX_TRACKED_PER_KEY = 32

const buckets = new Map<string, number[]>() // key -> ascending failure timestamps

function sweep(now: number): void {
  for (const [key, times] of buckets) {
    const kept = times.filter((t) => now - t < LONGEST_WINDOW_MS)
    if (kept.length === 0) buckets.delete(key)
    else buckets.set(key, kept)
  }
}

export function isLockedOut(key: string, now: number = Date.now()): boolean {
  sweep(now)
  const times = buckets.get(key)
  if (!times) return false
  return TIERS.some(
    (tier) => times.filter((t) => now - t < tier.windowMs).length >= tier.failures,
  )
}

/** Call ONLY for a failure that was actually evaluated. An attempt made while
 *  already locked out must not extend the lockout, or it could never decay (D16). */
export function recordFailure(key: string, now: number = Date.now()): void {
  sweep(now)
  const times = buckets.get(key) ?? []
  times.push(now)
  buckets.set(key, times.slice(-MAX_TRACKED_PER_KEY))
}

/** A successful, non-locked-out login clears the key (D17). */
export function clearFailures(key: string): void {
  buckets.delete(key)
}

/** x-forwarded-for first hop -> x-real-ip -> 'local' (D13). */
export function clientKey(headers: Headers): string {
  const fwd = headers.get('x-forwarded-for')
  if (fwd) return fwd.split(',')[0]!.trim()
  return headers.get('x-real-ip')?.trim() || 'local'
}

/** Test-only. */
export function resetRateLimiter(): void {
  buckets.clear()
}
