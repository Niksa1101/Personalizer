import type { Database } from "@/lib/database.types"
import { Badge } from "@/components/ui/badge"

type VideoRow = Database["public"]["Tables"]["videos"]["Row"]

type PacingIndicatorProps = {
  video: VideoRow | null
  maxStretchFactor: number
}

export function PacingIndicator({ video, maxStretchFactor }: PacingIndicatorProps) {
  if (!video) return null

  const usedFloor = video.used_speed_floor === true
  const stretch = video.stretch_factor ?? 0
  const nearLimit = stretch >= maxStretchFactor

  if (!usedFloor && !nearLimit) return null

  if (usedFloor) {
    return (
      <Badge variant="outline" className="font-normal">
        Scroll was slowed and held at the bottom to fit the intro
      </Badge>
    )
  }

  return (
    <Badge variant="outline" className="font-normal">
      Close to the stretch limit ({maxStretchFactor}×)
    </Badge>
  )
}
