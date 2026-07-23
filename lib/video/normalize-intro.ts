import "server-only"

import ffmpegPath from "ffmpeg-static"

import { buildNormalizeIntroArgs } from "@/lib/video/normalize-intro-args"
import { withTranscodeLock } from "@/lib/video/mutex"
import { runProcess } from "@/lib/video/spawn"

const FFMPEG_PATH = ffmpegPath!

/** Transcode an intro to the fixed 1080p / 30fps / H.264 / AAC profile (D5). */
export async function normalizeIntro(
  inputPath: string,
  outputPath: string,
  options: { hasAudio: boolean },
): Promise<void> {
  const args = buildNormalizeIntroArgs({
    inputPath,
    outputPath,
    hasAudio: options.hasAudio,
  })

  await withTranscodeLock(() => runProcess(FFMPEG_PATH, args))
}

export { buildNormalizeIntroArgs, type NormalizeIntroInput } from "@/lib/video/normalize-intro-args"
