export const MIN_SCROLL_DURATION_MS = 8_000
export const MAX_SCROLL_DURATION_MS = 90_000

/** Baseline scroll speed (px/s) — tuned so typical pages land in-range. */
const NOMINAL_V_PX_PER_SEC = 220

export type ScrollPlan = {
  durationMs: number
  scrollDistancePx: number
  vTargetPxPerSec: number
  easeMs: number
}

export function computeScrollPlan(
  pageHeightPx: number,
  viewportHeightPx: number,
  easeMs: number,
): ScrollPlan {
  const rawScrollDistance = Math.max(0, pageHeightPx - viewportHeightPx)

  if (rawScrollDistance <= viewportHeightPx * 0.1) {
    return {
      durationMs: MIN_SCROLL_DURATION_MS,
      scrollDistancePx: 0,
      vTargetPxPerSec: 0,
      easeMs: Math.min(easeMs, MIN_SCROLL_DURATION_MS / 2),
    }
  }

  const vTargetPxPerSec = NOMINAL_V_PX_PER_SEC
  const maxScrollDistancePx =
    vTargetPxPerSec * (MAX_SCROLL_DURATION_MS / 1000)
  const scrollDistancePx = Math.min(rawScrollDistance, maxScrollDistancePx)

  const rawDurationMs = (scrollDistancePx / vTargetPxPerSec) * 1000
  const durationMs = Math.max(
    MIN_SCROLL_DURATION_MS,
    Math.min(MAX_SCROLL_DURATION_MS, Math.round(rawDurationMs)),
  )

  const clampedEaseMs = Math.min(easeMs, Math.floor(durationMs / 2) - 1)

  return {
    durationMs,
    scrollDistancePx,
    vTargetPxPerSec,
    easeMs: Math.max(0, clampedEaseMs),
  }
}
