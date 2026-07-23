import "server-only"

import ffmpegPath from "ffmpeg-static"

import { withTranscodeLock } from "@/lib/video/mutex"
import { runProcess } from "@/lib/video/spawn"

const FFMPEG_PATH = ffmpegPath!

/** Extract a single JPEG poster frame (D6 — non-fatal at call site). */
export async function extractPoster(
  videoPath: string,
  outputPath: string,
  atSec: number,
): Promise<void> {
  const args = [
    "-y",
    "-ss",
    String(atSec),
    "-i",
    videoPath,
    "-frames:v",
    "1",
    "-q:v",
    "2",
    outputPath,
  ]

  await withTranscodeLock(() => runProcess(FFMPEG_PATH, args))
}
