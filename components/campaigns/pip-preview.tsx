"use client"

import type { MergeLayout } from "@/lib/campaign-types"
import { cn } from "@/lib/utils"

const FRAME_W = 1920
const FRAME_H = 1080
const MARGIN = 48

type PipPreviewProps = {
  mergeLayout: MergeLayout
  pipScale: number
  className?: string
}

function bubblePosition(layout: MergeLayout, pipW: number, pipH: number) {
  switch (layout) {
    case "bubble_br":
    case "rect_br":
      return { x: FRAME_W - pipW - MARGIN, y: FRAME_H - pipH - MARGIN }
    case "bubble_bl":
      return { x: MARGIN, y: FRAME_H - pipH - MARGIN }
    case "bubble_tr":
      return { x: FRAME_W - pipW - MARGIN, y: MARGIN }
    case "bubble_tl":
      return { x: MARGIN, y: MARGIN }
    default:
      return { x: FRAME_W - pipW - MARGIN, y: FRAME_H - pipH - MARGIN }
  }
}

function isCircular(layout: MergeLayout): boolean {
  return layout.startsWith("bubble_")
}

export function PipPreview({ mergeLayout, pipScale, className }: PipPreviewProps) {
  if (mergeLayout === "fullscreen_intro") {
    return (
      <div className={cn("space-y-3", className)}>
        <div className="aspect-video w-full max-w-xl overflow-hidden rounded-xl border border-border bg-muted/30">
          <div className="flex h-1/2 items-center justify-center border-b border-dashed border-border bg-primary/10 text-xs font-medium text-primary">
            Intro — full frame
          </div>
          <div className="flex h-1/2 items-center justify-center bg-muted/50 text-xs text-muted-foreground">
            Recording follows
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Fullscreen intro plays first, then the website recording. PiP scale does not apply.
        </p>
      </div>
    )
  }

  const pipW = Math.round(FRAME_W * pipScale)
  const pipH = pipW
  const { x, y } = bubblePosition(mergeLayout, pipW, pipH)
  const circular = isCircular(mergeLayout)

  const leftPct = (x / FRAME_W) * 100
  const topPct = (y / FRAME_H) * 100
  const widthPct = (pipW / FRAME_W) * 100
  const heightPct = (pipH / FRAME_H) * 100

  return (
    <div className={cn("space-y-3", className)}>
      <div className="relative aspect-video w-full max-w-xl overflow-hidden rounded-xl border border-border bg-gradient-to-br from-muted/80 to-muted/30">
        <div className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">
          Website recording
        </div>
        <div
          className={cn(
            "absolute border-2 border-primary bg-primary/20 shadow-sm",
            circular ? "rounded-full" : "rounded-lg",
          )}
          style={{
            left: `${leftPct}%`,
            top: `${topPct}%`,
            width: `${widthPct}%`,
            height: `${heightPct}%`,
          }}
        >
          <span className="absolute inset-0 flex items-center justify-center text-[10px] font-medium text-primary">
            Intro
          </span>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        Static mockup — {Math.round(pipScale * 100)}% width, 48px margin (Tech.md §9.2).
      </p>
    </div>
  )
}
