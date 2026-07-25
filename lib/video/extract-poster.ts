import "server-only"

import ffmpegPath from "ffmpeg-static"

import { withTranscodeLock } from "@/lib/video/mutex"
import { runProcess } from "@/lib/video/spawn"

const FFMPEG_PATH = ffmpegPath!

export type ExtractPosterOptions = {
  width?: number
  quality?: number
}

/** Extract a single JPEG poster frame (D6 — non-fatal at call site). */
export async function extractPoster(
  videoPath: string,
  outputPath: string,
  atSec: number,
  options?: ExtractPosterOptions,
): Promise<void> {
  const quality = options?.quality ?? 2
  const args = [
    "-y",
    "-ss",
    String(atSec),
    "-i",
    videoPath,
    "-frames:v",
    "1",
  ]

  if (options?.width != null) {
    args.push("-vf", `scale=${options.width}:-1`)
  }

  args.push("-q:v", String(quality), outputPath)

  await withTranscodeLock(() => runProcess(FFMPEG_PATH, args))
}
