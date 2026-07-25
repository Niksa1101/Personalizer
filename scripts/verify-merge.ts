/**
 * Phase 9 merge verification — hermetic FFmpeg legs with no DB or secrets.
 */

import { existsSync } from "node:fs"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { randomBytes } from "node:crypto"
import { tmpdir } from "node:os"
import path from "node:path"

import ffmpegPath from "ffmpeg-static"
import ffprobeStatic from "ffprobe-static"

import {
  buildMergeArgs,
  buildWebEncodeArgs,
  computeMergePlan,
} from "../lib/video/merge-plan"
import { probe } from "../lib/video/probe"
import { runProcess } from "../lib/video/spawn"

interface CheckResult {
  name: string
  ok: boolean
  detail: string
}

const FFMPEG = ffmpegPath!
const FFPROBE = ffprobeStatic.path
const VIDEO_TOLERANCE_MS = 34
const CONTAINER_TOLERANCE_MS = 67

const results: CheckResult[] = []

function pass(name: string, detail = "ok"): void {
  results.push({ name, ok: true, detail })
  console.log(`PASS  ${name}${detail === "ok" ? "" : ` — ${detail}`}`)
}

function fail(name: string, detail: string): void {
  results.push({ name, ok: false, detail })
  console.error(`FAIL  ${name} — ${detail}`)
}

async function runFfmpeg(args: string[]): Promise<{ stderr: string; ms: number }> {
  const startedAt = Date.now()
  const { stderr } = await runProcess(FFMPEG, args)
  return { stderr, ms: Date.now() - startedAt }
}

async function generateRecording(
  outputPath: string,
  durationSec: number,
  options?: { detailed?: boolean },
): Promise<void> {
  const source = options?.detailed
    ? "testsrc2=s=1920x1080:r=30"
    : "color=c=red:s=1920x1080:r=30"

  await runFfmpeg([
    "-y",
    "-f",
    "lavfi",
    "-i",
    source,
    "-t",
    String(durationSec),
    "-an",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    outputPath,
  ])
}

async function generateIntro(outputPath: string, durationSec: number): Promise<void> {
  await runFfmpeg([
    "-y",
    "-f",
    "lavfi",
    "-i",
    `color=c=blue:s=1920x1080:r=30`,
    "-f",
    "lavfi",
    "-i",
    `sine=f=440:duration=${durationSec}`,
    "-t",
    String(durationSec),
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-ar",
    "48000",
    "-shortest",
    outputPath,
  ])
}

async function mergeLeg(input: {
  name: string
  dIntroSec: number
  dRecSec: number
  layout?: string
  expectedDurationMs: number
  expectedFloor?: boolean
  containerToleranceMs?: number
  detailedRecording?: boolean
}): Promise<{ masterPath: string; webPath: string; plan: ReturnType<typeof computeMergePlan> }> {
  const root = mkdtempSync(path.join(tmpdir(), "pz-merge-leg-"))
  const recordingPath = path.join(root, "recording.mp4")
  const introPath = path.join(root, "intro.mp4")
  const masterPath = path.join(root, "final.mp4")
  const webPath = path.join(root, "web.mp4")

  try {
    await generateRecording(
      recordingPath,
      input.dRecSec,
      { detailed: input.detailedRecording ?? true },
    )
    await generateIntro(introPath, input.dIntroSec)

    const plan = computeMergePlan({
      dIntroMs: input.dIntroSec * 1000,
      dRecMs: input.dRecSec * 1000,
      maxStretch: 2.5,
      pipScale: 0.2,
      layout: input.layout ?? "bubble_br",
    })

    const masterStartedAt = Date.now()
    await runFfmpeg(
      buildMergeArgs({
        recordingPath,
        introPath,
        outputPath: masterPath,
        plan,
      }),
    )
    const masterMs = Date.now() - masterStartedAt
    console.log(`  ${input.name} master spawn: ${masterMs}ms`)

    const webStartedAt = Date.now()
    await runFfmpeg(
      buildWebEncodeArgs({
        masterPath,
        outputPath: webPath,
        webCrf: 28,
        webAudioKbps: 96,
      }),
    )
    const webMs = Date.now() - webStartedAt
    console.log(`  ${input.name} web spawn: ${webMs}ms`)

    const probedMaster = await probe(masterPath)
    const probedWeb = await probe(webPath)

    const videoDelta = Math.abs(probedMaster.durationMs - input.expectedDurationMs)
    if (videoDelta <= VIDEO_TOLERANCE_MS) {
      pass(`${input.name} video duration`, `${probedMaster.durationMs}ms`)
    } else {
      fail(
        `${input.name} video duration`,
        `expected ~${input.expectedDurationMs}ms ±${VIDEO_TOLERANCE_MS}, got ${probedMaster.durationMs}ms`,
      )
    }

    const containerTolerance =
      input.containerToleranceMs ?? CONTAINER_TOLERANCE_MS
    const containerDelta = Math.abs(probedWeb.durationMs - input.expectedDurationMs)
    if (containerDelta <= containerTolerance) {
      pass(`${input.name} container duration`, `${probedWeb.durationMs}ms`)
    } else {
      fail(
        `${input.name} container duration`,
        `expected ~${input.expectedDurationMs}ms ±${containerTolerance}, got ${probedWeb.durationMs}ms`,
      )
    }

    if (input.expectedFloor != null) {
      if (plan.usedSpeedFloor === input.expectedFloor) {
        pass(`${input.name} used_speed_floor`, String(plan.usedSpeedFloor))
      } else {
        fail(
          `${input.name} used_speed_floor`,
          `expected ${input.expectedFloor}, got ${plan.usedSpeedFloor}`,
        )
      }
      if (plan.stretchFactor === 2.5) {
        pass(`${input.name} stretch_factor at max`)
      } else {
        fail(
          `${input.name} stretch_factor at max`,
          `expected 2.5, got ${plan.stretchFactor}`,
        )
      }
    }

    if (probedMaster.hasAudio) {
      pass(`${input.name} master audio stream count`, "intro only")
    } else {
      fail(`${input.name} master audio stream count`, "expected intro audio track")
    }

    if (probedWeb.hasAudio) {
      pass(`${input.name} web audio stream count`, "intro only")
    } else {
      fail(`${input.name} web audio stream count`, "expected audio stream")
    }

    return { masterPath, webPath, plan }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

async function sampleRgbAt(
  videoPath: string,
  atSec: number,
  x: number,
  y: number,
): Promise<[number, number, number]> {
  const rawPath = path.join(
    tmpdir(),
    `pz-merge-px-${randomBytes(4).toString("hex")}.rgb`,
  )
  const px = Math.max(0, Math.min(1919, Math.round(x)))
  const py = Math.max(0, Math.min(1079, Math.round(y)))

  try {
    await runProcess(FFMPEG, [
      "-i",
      videoPath,
      "-ss",
      String(atSec),
      "-frames:v",
      "1",
      "-vf",
      "scale=1920:1080",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      rawPath,
    ])

    const rgb = readFileSync(rawPath)
    const idx = (py * 1920 + px) * 3
    return [rgb[idx] ?? 0, rgb[idx + 1] ?? 0, rgb[idx + 2] ?? 0]
  } finally {
    rmSync(rawPath, { force: true })
  }
}

function isBlue([r, , b]: [number, number, number]): boolean {
  return b > 120 && b > r + 40
}

function isRed([r, , b]: [number, number, number]): boolean {
  return r > 120 && r > b + 40
}

async function assertBubbleGeometry(
  masterPath: string,
  plan: ReturnType<typeof computeMergePlan>,
): Promise<void> {
  const atSec = plan.targetMs / 2000
  const cx = plan.ox + plan.pipW / 2
  const cy = plan.oy + plan.pipH / 2
  const points: Array<[string, number, number, "blue" | "red"]> = [
    ["center", cx, cy, "blue"],
    ["top", cx, plan.oy, "blue"],
    ["bottom", cx, plan.oy + plan.pipH - 1, "blue"],
    ["left", plan.ox, cy, "blue"],
    ["right", plan.ox + plan.pipW - 1, cy, "blue"],
    ["corner-tl", plan.ox, plan.oy, "red"],
    ["corner-tr", plan.ox + plan.pipW - 1, plan.oy, "red"],
    ["corner-bl", plan.ox, plan.oy + plan.pipH - 1, "red"],
    ["corner-br", plan.ox + plan.pipW - 1, plan.oy + plan.pipH - 1, "red"],
  ]

  for (const [label, x, y, expected] of points) {
    const rgb = await sampleRgbAt(masterPath, atSec, Math.round(x), Math.round(y))
    const ok = expected === "blue" ? isBlue(rgb) : isRed(rgb)
    if (ok) {
      pass(`geometry ${label}`, `rgb(${rgb.join(",")})`)
    } else {
      fail(
        `geometry ${label}`,
        `expected ${expected}, got rgb(${rgb.join(",")}) at (${x},${y})`,
      )
    }
  }
}

async function assertRectGeometry(
  masterPath: string,
  plan: ReturnType<typeof computeMergePlan>,
): Promise<void> {
  const atSec = plan.targetMs / 2000
  const corners: Array<[string, number, number]> = [
    ["corner-tl", plan.ox, plan.oy],
    ["corner-tr", plan.ox + plan.pipW - 1, plan.oy],
    ["corner-bl", plan.ox, plan.oy + plan.pipH - 1],
    ["corner-br", plan.ox + plan.pipW - 1, plan.oy + plan.pipH - 1],
  ]

  for (const [label, x, y] of corners) {
    const rgb = await sampleRgbAt(masterPath, atSec, Math.round(x), Math.round(y))
    if (isBlue(rgb)) {
      pass(`rect ${label}`, `rgb(${rgb.join(",")})`)
    } else {
      fail(
        `rect ${label}`,
        `expected intro blue, got rgb(${rgb.join(",")}) at (${x},${y})`,
      )
    }
  }
}

function assertFastStart(webPath: string): void {
  const buf = readFileSync(webPath)
  const atoms: string[] = []
  let offset = 0
  while (offset + 8 <= buf.length) {
    const size = buf.readUInt32BE(offset)
    const type = buf.toString("ascii", offset + 4, offset + 8)
    if (size < 8) break
    atoms.push(type)
    offset += size
    if (atoms.length >= 4) break
  }

  const moovIndex = atoms.indexOf("moov")
  const mdatIndex = atoms.indexOf("mdat")
  if (moovIndex >= 0 && mdatIndex >= 0 && moovIndex < mdatIndex) {
    pass("web faststart", atoms.join(", "))
  } else {
    fail("web faststart", `box order ${atoms.join(", ")}`)
  }
}

async function main(): Promise<void> {
  if (!FFMPEG || !existsSync(FFMPEG)) {
    console.error(
      "ffmpeg-static binary missing. Run:\n  npm install-scripts approve ffmpeg-static\n  node node_modules/ffmpeg-static/install.js",
    )
    process.exit(1)
  }

  if (!FFPROBE || !existsSync(FFPROBE)) {
    console.error(
      "ffprobe-static binary missing. Reinstall ffprobe-static or run npm install.",
    )
    process.exit(1)
  }

  pass("ffmpeg binary present", FFMPEG)
  pass("ffprobe binary present", FFPROBE)

  await mergeLeg({
    name: "leg1-trim",
    dIntroSec: 5,
    dRecSec: 8,
    expectedDurationMs: 5000,
  })

  await mergeLeg({
    name: "leg2-stretch",
    dIntroSec: 10,
    dRecSec: 5,
    expectedDurationMs: 10000,
  })

  const leg2Root = mkdtempSync(path.join(tmpdir(), "pz-merge-geom-"))
  const leg2Recording = path.join(leg2Root, "recording.mp4")
  const leg2Intro = path.join(leg2Root, "intro.mp4")
  const leg2Master = path.join(leg2Root, "final.mp4")
  try {
    await generateRecording(leg2Recording, 5)
    await generateIntro(leg2Intro, 10)
    const plan = computeMergePlan({
      dIntroMs: 10_000,
      dRecMs: 5000,
      maxStretch: 2.5,
      pipScale: 0.2,
      layout: "bubble_br",
    })
    await runFfmpeg(
      buildMergeArgs({
        recordingPath: leg2Recording,
        introPath: leg2Intro,
        outputPath: leg2Master,
        plan,
      }),
    )
    await assertBubbleGeometry(leg2Master, plan)
  } finally {
    rmSync(leg2Root, { recursive: true, force: true })
  }

  await mergeLeg({
    name: "leg3-floor",
    dIntroSec: 30,
    dRecSec: 5,
    expectedDurationMs: 30_000,
    expectedFloor: true,
  })

  const rectRoot = mkdtempSync(path.join(tmpdir(), "pz-merge-rect-"))
  const rectRecording = path.join(rectRoot, "recording.mp4")
  const rectIntro = path.join(rectRoot, "intro.mp4")
  const rectMaster = path.join(rectRoot, "final.mp4")
  try {
    await generateRecording(rectRecording, 5, { detailed: true })
    await generateIntro(rectIntro, 10)
    const rectPlan = computeMergePlan({
      dIntroMs: 10_000,
      dRecMs: 5000,
      maxStretch: 2.5,
      pipScale: 0.2,
      layout: "rect_br",
    })
    await runFfmpeg(
      buildMergeArgs({
        recordingPath: rectRecording,
        introPath: rectIntro,
        outputPath: rectMaster,
        plan: rectPlan,
      }),
    )
    await assertRectGeometry(rectMaster, rectPlan)
  } finally {
    rmSync(rectRoot, { recursive: true, force: true })
  }

  const leg4Root = mkdtempSync(path.join(tmpdir(), "pz-merge-fullscreen-"))
  const leg4Recording = path.join(leg4Root, "recording.mp4")
  const leg4Intro = path.join(leg4Root, "intro.mp4")
  const leg4Master = path.join(leg4Root, "final.mp4")
  const leg4Web = path.join(leg4Root, "web.mp4")
  try {
    await generateRecording(leg4Recording, 5, { detailed: true })
    await generateIntro(leg4Intro, 3)
    const plan = computeMergePlan({
      dIntroMs: 3000,
      dRecMs: 5000,
      maxStretch: 2.5,
      pipScale: 0.2,
      layout: "fullscreen_intro",
    })
    const masterStartedAt = Date.now()
    await runFfmpeg(
      buildMergeArgs({
        recordingPath: leg4Recording,
        introPath: leg4Intro,
        outputPath: leg4Master,
        plan,
      }),
    )
    console.log(`  leg4-fullscreen master spawn: ${Date.now() - masterStartedAt}ms`)
    await runFfmpeg(
      buildWebEncodeArgs({
        masterPath: leg4Master,
        outputPath: leg4Web,
        webCrf: 28,
        webAudioKbps: 96,
      }),
    )
    const probed = await probe(leg4Master)
    const expectedMs = 8000
    if (Math.abs(probed.durationMs - expectedMs) <= CONTAINER_TOLERANCE_MS) {
      pass("leg4-fullscreen duration", `${probed.durationMs}ms`)
    } else {
      fail(
        "leg4-fullscreen duration",
        `expected ~${expectedMs}ms, got ${probed.durationMs}ms`,
      )
    }
    assertFastStart(leg4Web)
  } finally {
    rmSync(leg4Root, { recursive: true, force: true })
  }

  const leg2WebRoot = mkdtempSync(path.join(tmpdir(), "pz-merge-faststart-"))
  try {
    await generateRecording(path.join(leg2WebRoot, "recording.mp4"), 5, {
      detailed: true,
    })
    await generateIntro(path.join(leg2WebRoot, "intro.mp4"), 10)
    const master = path.join(leg2WebRoot, "final.mp4")
    const web = path.join(leg2WebRoot, "web.mp4")
    const plan = computeMergePlan({
      dIntroMs: 10_000,
      dRecMs: 5000,
      maxStretch: 2.5,
      pipScale: 0.2,
      layout: "bubble_br",
    })
    await runFfmpeg(
      buildMergeArgs({
        recordingPath: path.join(leg2WebRoot, "recording.mp4"),
        introPath: path.join(leg2WebRoot, "intro.mp4"),
        outputPath: master,
        plan,
      }),
    )
    await runFfmpeg(
      buildWebEncodeArgs({
        masterPath: master,
        outputPath: web,
        webCrf: 28,
        webAudioKbps: 96,
      }),
    )
    assertFastStart(web)
  } finally {
    rmSync(leg2WebRoot, { recursive: true, force: true })
  }

  const failed = results.filter((result) => !result.ok).length
  console.log(`\n${results.length - failed}/${results.length} checks passed`)
  if (failed > 0) process.exit(1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
