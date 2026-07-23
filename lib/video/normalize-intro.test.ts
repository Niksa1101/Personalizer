import { strict as assert } from "node:assert"
import { describe, it } from "node:test"

import { buildNormalizeIntroArgs } from "./normalize-intro-args"

describe("buildNormalizeIntroArgs", () => {
  it("emits the D5 padded-scale filter chain for sources with audio", () => {
    const args = buildNormalizeIntroArgs({
      inputPath: "/in.mp4",
      outputPath: "/out.mp4",
      hasAudio: true,
    })

    const joined = args.join(" ")
    assert.match(
      joined,
      /scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:\(ow-iw\)\/2:\(oh-ih\)\/2,fps=30,format=yuv420p/,
    )
    assert.match(joined, /libx264 -preset medium -crf 20 -pix_fmt yuv420p/)
    assert.match(joined, /aac -b:a 128k -ar 48000 -ac 2/)
    assert.ok(!joined.includes("anullsrc"))
    assert.ok(!joined.includes("-shortest"))
  })

  it("adds silent-track lavfi inputs when the probe reports no audio", () => {
    const args = buildNormalizeIntroArgs({
      inputPath: "/in.mp4",
      outputPath: "/out.mp4",
      hasAudio: false,
    })

    const joined = args.join(" ")
    assert.match(joined, /anullsrc=channel_layout=stereo:sample_rate=48000/)
    assert.match(joined, /-map 0:v -map 1:a -shortest/)
  })
})
