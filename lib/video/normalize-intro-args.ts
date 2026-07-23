const VIDEO_FILTER =
  "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,fps=30,format=yuv420p"

export interface NormalizeIntroInput {
  inputPath: string
  outputPath: string
  hasAudio: boolean
}

/** Pure FFmpeg arg builder for intro normalization (D5) — exported for unit tests. */
export function buildNormalizeIntroArgs(input: NormalizeIntroInput): string[] {
  const args = ["-y", "-i", input.inputPath]

  if (!input.hasAudio) {
    args.push(
      "-f",
      "lavfi",
      "-i",
      "anullsrc=channel_layout=stereo:sample_rate=48000",
    )
  }

  args.push(
    "-vf",
    VIDEO_FILTER,
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    "20",
    "-pix_fmt",
    "yuv420p",
  )

  if (!input.hasAudio) {
    args.push("-map", "0:v", "-map", "1:a", "-shortest")
  }

  args.push(
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-ar",
    "48000",
    "-ac",
    "2",
    input.outputPath,
  )

  return args
}
