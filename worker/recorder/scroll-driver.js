// Sole injected scroll driver (Tech.md §8.4). Plan math lives in scroll.ts.
async function runScrollDriver({ distancePx, durationMs, easeMs }) {
  const easeOutCubic = (t) => 1 - (1 - t) ** 3

  await new Promise((resolve) => {
    const startY = window.scrollY
    const start = performance.now()
    let lastElapsed = 0
    let position = 0

    const velocityAt = (elapsed) => {
      if (durationMs <= 0) return 0
      const vTarget = distancePx / Math.max(durationMs - easeMs, 1)
      if (easeMs <= 0) return vTarget
      if (elapsed < easeMs) {
        return vTarget * easeOutCubic(elapsed / easeMs)
      }
      if (elapsed > durationMs - easeMs) {
        return vTarget * easeOutCubic((durationMs - elapsed) / easeMs)
      }
      return vTarget
    }

    const tick = (now) => {
      const elapsed = now - start
      if (elapsed >= durationMs) {
        window.scrollTo(0, startY + distancePx)
        resolve()
        return
      }

      const deltaMs = elapsed - lastElapsed
      lastElapsed = elapsed
      position += velocityAt(elapsed) * deltaMs
      window.scrollTo(0, startY + Math.min(position, distancePx))
      requestAnimationFrame(tick)
    }

    requestAnimationFrame(tick)
  })
}

module.exports = { runScrollDriver }
