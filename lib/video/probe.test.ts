import { strict as assert } from "node:assert"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { after, before, describe, it } from "node:test"

import ffmpegPath from "ffmpeg-static"

import { normalizeIntro } from "./normalize-intro"
import { parseProbeOutput, probe } from "./probe"
import { runProcess } from "./spawn"

function ffprobeJson(value: unknown): string {
  return JSON.stringify(value)
}

describe("parseProbeOutput", () => {
  it("maps video + audio streams to a ProbeResult", () => {
    const result = parseProbeOutput(
      ffprobeJson({
        format: { duration: "12.345678" },
        streams: [
          { codec_type: "video", width: 1280, height: 720, avg_frame_rate: "30000/1001" },
          { codec_type: "audio" },
        ],
      }),
    )

    assert.deepEqual(result, {
      durationMs: 12346,
      width: 1280,
      height: 720,
      fps: 29.97,
      hasAudio: true,
    })
  })

  it("reports hasAudio=false for a silent screen recording", () => {
    const result = parseProbeOutput(
      ffprobeJson({
        format: { duration: "5" },
        streams: [{ codec_type: "video", width: 1920, height: 1080, avg_frame_rate: "30/1" }],
      }),
    )

    assert.equal(result.hasAudio, false)
    assert.equal(result.durationMs, 5000)
  })

  it("falls back from avg_frame_rate to r_frame_rate, then to 30", () => {
    const viaR = parseProbeOutput(
      ffprobeJson({
        format: { duration: "1" },
        streams: [
          { codec_type: "video", width: 640, height: 360, avg_frame_rate: "0/0", r_frame_rate: "25/1" },
        ],
      }),
    )
    assert.equal(viaR.fps, 25)

    const defaulted = parseProbeOutput(
      ffprobeJson({
        format: { duration: "1" },
        streams: [{ codec_type: "video", width: 640, height: 360 }],
      }),
    )
    assert.equal(defaulted.fps, 30)
  })

  it("rejects output that is not JSON", () => {
    assert.throws(() => parseProbeOutput("not json"), /Could not read this file as a video/)
  })

  it("rejects files with no video stream (e.g. an mp3 uploaded as an intro)", () => {
    assert.throws(
      () =>
        parseProbeOutput(
          ffprobeJson({ format: { duration: "3" }, streams: [{ codec_type: "audio" }] }),
        ),
      /Could not read this file as a video/,
    )
  })

  it("rejects a missing or non-positive duration", () => {
    for (const duration of [undefined, "N/A", "0", "-1"]) {
      assert.throws(
        () =>
          parseProbeOutput(
            ffprobeJson({
              format: { duration },
              streams: [{ codec_type: "video", width: 640, height: 360 }],
            }),
          ),
        /Could not determine video duration/,
      )
    }
  })
})

// Real FFmpeg round-trip: synthesize clips, probe them, normalize one. No
// network, no database — just the bundled ffmpeg/ffprobe binaries.
describe("probe + normalizeIntro against real media", { skip: !ffmpegPath || !existsSync(ffmpegPath) }, () => {
  let dir: string

  before(() => {
    dir = mkdtempSync(path.join(tmpdir(), "pz-probe-"))
  })

  after(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  async function synthesize(name: string, withAudio: boolean): Promise<string> {
    const out = path.join(dir, name)
    const args = ["-y", "-f", "lavfi", "-i", "testsrc2=size=640x480:rate=25:duration=1"]
    if (withAudio) args.push("-f", "lavfi", "-i", "sine=frequency=440:duration=1")
    args.push("-c:v", "libx264", "-pix_fmt", "yuv420p")
    if (withAudio) args.push("-c:a", "aac", "-shortest")
    args.push(out)
    await runProcess(ffmpegPath!, args, 60_000)
    return out
  }

  it("probes a synthesized 640x480 / 25fps clip with audio", async () => {
    const clip = await synthesize("with-audio.mp4", true)
    const result = await probe(clip)

    assert.equal(result.width, 640)
    assert.equal(result.height, 480)
    assert.equal(result.fps, 25)
    assert.equal(result.hasAudio, true)
    assert.ok(Math.abs(result.durationMs - 1000) <= 100, `duration ${result.durationMs}ms`)
  })

  it("normalizes a silent 4:3 intro to 1080p / 30fps with a silent stereo track", async () => {
    const clip = await synthesize("silent.mp4", false)
    const source = await probe(clip)
    assert.equal(source.hasAudio, false)

    const normalized = path.join(dir, "normalized.mp4")
    await normalizeIntro(clip, normalized, { hasAudio: source.hasAudio })
    const result = await probe(normalized)

    assert.equal(result.width, 1920)
    assert.equal(result.height, 1080)
    assert.equal(result.fps, 30)
    assert.equal(result.hasAudio, true)
    assert.ok(Math.abs(result.durationMs - 1000) <= 150, `duration ${result.durationMs}ms`)
  })

  it("rejects a file that is not media", async () => {
    const bogus = path.join(dir, "bogus.mp4")
    writeFileSync(bogus, "definitely not a video")

    await assert.rejects(probe(bogus), /Could not read this file as a video/)
  })
})
