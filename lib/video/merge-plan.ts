import type { MergeLayout } from "@/lib/settings"

const FRAME_W = 1920
const FRAME_H = 1080
const MARGIN = 48
const MAX_BUBBLE_PIP_W = FRAME_H - 2 * MARGIN

const BUBBLE_LAYOUTS = new Set<MergeLayout>([
  "bubble_br",
  "bubble_bl",
  "bubble_tr",
  "bubble_tl",
])

const RECOGNIZED_LAYOUTS = new Set<MergeLayout>([
  "bubble_br",
  "bubble_bl",
  "bubble_tr",
  "bubble_tl",
  "rect_br",
  "fullscreen_intro",
])

export interface ComputeMergePlanInput {
  dIntroMs: number
  dRecMs: number
  maxStretch: number
  pipScale: number
  layout: string
}

export interface MergePlan {
  layout: MergeLayout
  isFullscreenIntro: boolean
  dRecMs: number
  /** Full-precision stretch for the filter graph. */
  stretchGraph: number
  /** Rounded to 3dp for numeric(6,3). */
  stretchFactor: number
  usedSpeedFloor: boolean
  holdMs: number
  holdSec: number
  targetMs: number
  applySetpts: boolean
  applyTpad: boolean
  pipW: number
  pipH: number
  ox: number
  oy: number
  r: number
  cx: number
  cy: number
  circular: boolean
  warnings: string[]
}

function toEven(n: number): number {
  const rounded = Math.round(n)
  return rounded % 2 === 0 ? rounded : rounded + 1
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000
}

function introSeconds(dIntroMs: number): string {
  return (dIntroMs / 1000).toFixed(3)
}

function resolveLayout(raw: string): { layout: MergeLayout; warnings: string[] } {
  if (RECOGNIZED_LAYOUTS.has(raw as MergeLayout)) {
    return { layout: raw as MergeLayout, warnings: [] }
  }
  return {
    layout: "bubble_br",
    warnings: [`Unrecognized merge layout "${raw}" — falling back to bubble_br.`],
  }
}

function clampPipScale(scale: number, warnings: string[]): number {
  if (scale < 0.05) {
    warnings.push(`pip_scale ${scale} below minimum 0.05 — clamped.`)
    return 0.05
  }
  if (scale > 0.6) {
    warnings.push(`pip_scale ${scale} above maximum 0.60 — clamped.`)
    return 0.6
  }
  return scale
}

function computePipGeometry(
  layout: MergeLayout,
  pipScale: number,
  warnings: string[],
): Pick<
  MergePlan,
  "pipW" | "pipH" | "ox" | "oy" | "r" | "cx" | "cy" | "circular"
> {
  const clampedScale = clampPipScale(pipScale, warnings)
  let pipW = toEven(Math.round(FRAME_W * clampedScale))

  if (BUBBLE_LAYOUTS.has(layout) && pipW > MAX_BUBBLE_PIP_W) {
    warnings.push(
      `PiP width ${pipW}px exceeds bubble maximum ${MAX_BUBBLE_PIP_W}px — clamped.`,
    )
    pipW = MAX_BUBBLE_PIP_W
  }

  const circular = BUBBLE_LAYOUTS.has(layout)
  const pipH =
    layout === "rect_br" ? toEven(Math.round((pipW * 9) / 16)) : pipW
  const r = circular ? pipW / 2 : 0
  const cx = circular ? pipW / 2 : 0
  const cy = circular ? pipH / 2 : 0

  let ox: number
  let oy: number
  switch (layout) {
    case "bubble_br":
    case "rect_br":
      ox = FRAME_W - pipW - MARGIN
      oy = FRAME_H - pipH - MARGIN
      break
    case "bubble_bl":
      ox = MARGIN
      oy = FRAME_H - pipH - MARGIN
      break
    case "bubble_tr":
      ox = FRAME_W - pipW - MARGIN
      oy = MARGIN
      break
    case "bubble_tl":
      ox = MARGIN
      oy = MARGIN
      break
    default:
      ox = FRAME_W - pipW - MARGIN
      oy = FRAME_H - pipH - MARGIN
  }

  return { pipW, pipH, ox, oy, r, cx, cy, circular }
}

export function computeMergePlan(input: ComputeMergePlanInput): MergePlan {
  const { layout, warnings: layoutWarnings } = resolveLayout(input.layout)
  const warnings = [...layoutWarnings]

  if (layout === "fullscreen_intro") {
    return {
      layout,
      isFullscreenIntro: true,
      dRecMs: input.dRecMs,
      stretchGraph: 1,
      stretchFactor: 1,
      usedSpeedFloor: false,
      holdMs: 0,
      holdSec: 0,
      targetMs: input.dIntroMs + input.dRecMs,
      applySetpts: false,
      applyTpad: false,
      pipW: 0,
      pipH: 0,
      ox: 0,
      oy: 0,
      r: 0,
      cx: 0,
      cy: 0,
      circular: false,
      warnings,
    }
  }

  const stretch = input.dIntroMs / input.dRecMs
  const geom = computePipGeometry(layout, input.pipScale, warnings)

  if (stretch < 1) {
    return {
      layout,
      isFullscreenIntro: false,
      dRecMs: input.dRecMs,
      stretchGraph: 1,
      stretchFactor: 1,
      usedSpeedFloor: false,
      holdMs: 0,
      holdSec: 0,
      targetMs: input.dIntroMs,
      applySetpts: false,
      applyTpad: false,
      ...geom,
      warnings,
    }
  }

  if (stretch <= input.maxStretch) {
    return {
      layout,
      isFullscreenIntro: false,
      dRecMs: input.dRecMs,
      stretchGraph: stretch,
      stretchFactor: round3(stretch),
      usedSpeedFloor: false,
      holdMs: 0,
      holdSec: 0,
      targetMs: input.dIntroMs,
      applySetpts: true,
      applyTpad: false,
      ...geom,
      warnings,
    }
  }

  const stretchGraph = input.maxStretch
  const holdMs = input.dIntroMs - input.dRecMs * input.maxStretch
  const holdSec = holdMs / 1000

  if (holdMs > input.dIntroMs * 0.5) {
    warnings.push(
      `Speed-floor hold is ${Math.round((holdMs / input.dIntroMs) * 100)}% of output duration — use a shorter intro or accept the frozen final frame.`,
    )
  }

  return {
    layout,
    isFullscreenIntro: false,
    dRecMs: input.dRecMs,
    stretchGraph,
    stretchFactor: round3(stretchGraph),
    usedSpeedFloor: true,
    holdMs,
    holdSec,
    targetMs: input.dIntroMs,
    applySetpts: true,
    applyTpad: true,
    ...geom,
    warnings,
  }
}

export interface BuildMergeArgsInput {
  recordingPath: string
  introPath: string
  outputPath: string
  plan: MergePlan
}

function buildBaseChain(plan: MergePlan): string {
  const parts: string[] = []
  if (plan.applySetpts) {
    parts.push(`setpts=${plan.stretchGraph}*PTS`)
  }
  parts.push(
    "scale=1920:1080:force_original_aspect_ratio=increase",
    "crop=1920:1080",
    "fps=30",
  )
  if (plan.applyTpad) {
    parts.push(`tpad=stop_mode=clone:stop_duration=${plan.holdSec}`)
  }
  return parts.join(",")
}

function geqMaskExpression(cx: number, cy: number, r: number): string {
  return `geq=lum=255*lte(hypot(X-${cx}\\,Y-${cy})\\,${r})`
}

function buildOverlayFilterComplex(plan: MergePlan): string {
  const baseChain = buildBaseChain(plan)
  const pipScale = `scale=${plan.pipW}:${plan.pipH}:force_original_aspect_ratio=increase,crop=${plan.pipW}:${plan.pipH},fps=30,format=rgba`

  if (plan.circular) {
    return [
      `[0:v]${baseChain}[base]`,
      `[1:v]${pipScale}[pipsrc]`,
      `color=c=black:s=${plan.pipW}x${plan.pipH},format=gray,${geqMaskExpression(plan.cx, plan.cy, plan.r)}[mask]`,
      "[pipsrc][mask]alphamerge[pip]",
      `[base][pip]overlay=${plan.ox}:${plan.oy}:shortest=0[outv]`,
    ].join(";")
  }

  return [
    `[0:v]${baseChain}[base]`,
    `[1:v]${pipScale}[pip]`,
    `[base][pip]overlay=${plan.ox}:${plan.oy}:shortest=0[outv]`,
  ].join(";")
}

function buildFullscreenFilterComplex(plan: MergePlan): string {
  const segmentPrep =
    "scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,fps=30,setsar=1"
  const dRecSec = (plan.dRecMs / 1000).toFixed(3)
  const aformat =
    "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo"

  return [
    `[0:v]${segmentPrep}[v0]`,
    `[1:v]${segmentPrep}[v1]`,
    "[v0][v1]concat=n=2:v=1:a=0[outv]",
    `[0:a]${aformat}[a0]`,
    `anullsrc=r=48000:cl=stereo,atrim=0:${dRecSec}[recsilence]`,
    `[recsilence]${aformat}[a1]`,
    "[a0][a1]concat=n=2:v=0:a=1[outa]",
  ].join(";")
}

/** Pure FFmpeg arg builder for the master merge encode. */
export function buildMergeArgs(input: BuildMergeArgsInput): string[] {
  const { recordingPath, introPath, outputPath, plan } = input

  if (plan.isFullscreenIntro) {
    return [
      "-y",
      "-i",
      introPath,
      "-i",
      recordingPath,
      "-filter_complex",
      buildFullscreenFilterComplex(plan),
      "-map",
      "[outv]",
      "-map",
      "[outa]",
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-crf",
      "20",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-ar",
      "48000",
      outputPath,
    ]
  }

  return [
    "-y",
    "-i",
    recordingPath,
    "-i",
    introPath,
    "-filter_complex",
    buildOverlayFilterComplex(plan),
    "-map",
    "[outv]",
    "-map",
    "1:a",
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    "20",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-ar",
    "48000",
    "-t",
    introSeconds(plan.targetMs),
    outputPath,
  ]
}

export interface BuildWebEncodeArgsInput {
  masterPath: string
  outputPath: string
  webCrf: number
  webAudioKbps: number
}

/** Second-pass 720p web encode from the local master. */
export function buildWebEncodeArgs(input: BuildWebEncodeArgsInput): string[] {
  return [
    "-y",
    "-i",
    input.masterPath,
    "-vf",
    "scale=1280:720",
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    String(input.webCrf),
    "-c:a",
    "aac",
    "-b:a",
    `${input.webAudioKbps}k`,
    "-ar",
    "48000",
    "-movflags",
    "+faststart",
    input.outputPath,
  ]
}
