import "server-only"

import ffprobeStatic from "ffprobe-static"

import { FfmpegProcessError, runProcess } from "@/lib/video/spawn"

const FFPROBE_PATH = ffprobeStatic.path

export interface ProbeResult {
  durationMs: number
  width: number
  height: number
  fps: number
  hasAudio: boolean
}

interface FfprobeStream {
  codec_type?: string
  width?: number
  height?: number
  r_frame_rate?: string
  avg_frame_rate?: string
}

interface FfprobeJson {
  format?: { duration?: string }
  streams?: FfprobeStream[]
}

function parseFps(rate: string | undefined): number {
  if (!rate || rate === "0/0") return 0
  const [num, den] = rate.split("/").map(Number)
  if (!den || Number.isNaN(num) || Number.isNaN(den)) return 0
  return num / den
}

function roundFps(fps: number): number {
  return Math.round(fps * 100) / 100
}

/** Probe a media file via ffprobe (D4 input validation + post-normalize metadata). */
export async function probe(filePath: string): Promise<ProbeResult> {
  let stdout: string
  try {
    ;({ stdout } = await runProcess(
      FFPROBE_PATH,
      [
        "-v",
        "quiet",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
        filePath,
      ],
      60_000,
    ))
  } catch (error) {
    if (error instanceof FfmpegProcessError) {
      throw new Error(
        "Could not read this file as a video. Upload a format FFmpeg can decode.",
      )
    }
    throw error
  }

  let parsed: FfprobeJson
  try {
    parsed = JSON.parse(stdout) as FfprobeJson
  } catch {
    throw new Error(
      "Could not read this file as a video. Upload a format FFmpeg can decode.",
    )
  }

  const videoStream = parsed.streams?.find((s) => s.codec_type === "video")
  if (!videoStream?.width || !videoStream.height) {
    throw new Error(
      "Could not read this file as a video. Upload a format FFmpeg can decode.",
    )
  }

  const durationSec = Number(parsed.format?.duration)
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    throw new Error(
      "Could not determine video duration. Upload a format FFmpeg can decode.",
    )
  }

  const fps =
    parseFps(videoStream.avg_frame_rate) ||
    parseFps(videoStream.r_frame_rate) ||
    30

  const hasAudio = parsed.streams?.some((s) => s.codec_type === "audio") ?? false

  return {
    durationMs: Math.round(durationSec * 1000),
    width: videoStream.width,
    height: videoStream.height,
    fps: roundFps(fps),
    hasAudio,
  }
}
