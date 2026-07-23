/** Human-readable intro duration for the grid master-clock display. */
export function formatIntroDuration(durationMs: number): string {
  const totalSec = Math.round(durationMs / 1000)
  const min = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  if (min === 0) return `${sec}s`
  return `${min}:${sec.toString().padStart(2, "0")}`
}

/** Compact file size label for intro cards. */
export function formatFileSize(bytes: number | null): string {
  if (bytes == null || bytes <= 0) return "—"
  const units = ["B", "KB", "MB", "GB"] as const
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return unit === 0 ? `${value} ${units[unit]}` : `${value.toFixed(1)} ${units[unit]}`
}
