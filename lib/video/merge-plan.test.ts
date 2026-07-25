import { strict as assert } from "node:assert"
import { describe, it } from "node:test"

import { computeMergePlan, buildMergeArgs } from "./merge-plan"

describe("computeMergePlan", () => {
  it("trim case: stretch < 1 emits no setpts and persists stretch_factor 1.0", () => {
    const plan = computeMergePlan({
      dIntroMs: 5000,
      dRecMs: 8000,
      maxStretch: 2.5,
      pipScale: 0.2,
      layout: "bubble_br",
    })

    assert.equal(plan.applySetpts, false)
    assert.equal(plan.stretchFactor, 1)
    assert.equal(plan.usedSpeedFloor, false)
    assert.equal(plan.targetMs, 5000)
  })

  it("mid-range stretch applies setpts", () => {
    const plan = computeMergePlan({
      dIntroMs: 10000,
      dRecMs: 5000,
      maxStretch: 2.5,
      pipScale: 0.2,
      layout: "bubble_br",
    })

    assert.equal(plan.applySetpts, true)
    assert.equal(plan.stretchGraph, 2)
    assert.equal(plan.stretchFactor, 2)
    assert.equal(plan.usedSpeedFloor, false)
  })

  it("stretch == max is mid-range, not the speed floor", () => {
    const plan = computeMergePlan({
      dIntroMs: 12500,
      dRecMs: 5000,
      maxStretch: 2.5,
      pipScale: 0.2,
      layout: "bubble_br",
    })

    assert.equal(plan.stretchGraph, 2.5)
    assert.equal(plan.usedSpeedFloor, false)
    assert.equal(plan.applyTpad, false)
  })

  it("stretch > max applies tpad after fps=30", () => {
    const plan = computeMergePlan({
      dIntroMs: 60000,
      dRecMs: 5000,
      maxStretch: 2.5,
      pipScale: 0.2,
      layout: "bubble_br",
    })

    assert.equal(plan.usedSpeedFloor, true)
    assert.equal(plan.stretchGraph, 2.5)
    assert.equal(plan.applyTpad, true)
    assert.equal(plan.holdMs, 60000 - 5000 * 2.5)

    const args = buildMergeArgs({
      recordingPath: "/rec.mp4",
      introPath: "/intro.mp4",
      outputPath: "/out.mp4",
      plan,
    })
    const filter = args[args.indexOf("-filter_complex") + 1]!
    const fpsIndex = filter.indexOf("fps=30")
    const tpadIndex = filter.indexOf("tpad=")
    assert.ok(fpsIndex >= 0 && tpadIndex > fpsIndex)
  })

  it("clamps bubble pip width to 984px", () => {
    const plan = computeMergePlan({
      dIntroMs: 10000,
      dRecMs: 5000,
      maxStretch: 2.5,
      pipScale: 0.6,
      layout: "bubble_br",
    })

    assert.equal(plan.pipW, 984)
    assert.ok(plan.warnings.some((w) => w.includes("984")))
  })

  it("rounds pip dimensions to even values", () => {
    const plan = computeMergePlan({
      dIntroMs: 10000,
      dRecMs: 5000,
      maxStretch: 2.5,
      pipScale: 0.21,
      layout: "rect_br",
    })

    assert.equal(plan.pipW % 2, 0)
    assert.equal(plan.pipH % 2, 0)
  })

  it("warns and clamps out-of-range pip_scale", () => {
    const low = computeMergePlan({
      dIntroMs: 10000,
      dRecMs: 5000,
      maxStretch: 2.5,
      pipScale: 0.01,
      layout: "bubble_br",
    })
    assert.ok(low.warnings.some((w) => w.includes("0.05")))

    const high = computeMergePlan({
      dIntroMs: 10000,
      dRecMs: 5000,
      maxStretch: 2.5,
      pipScale: 0.9,
      layout: "bubble_br",
    })
    assert.ok(high.warnings.some((w) => w.includes("0.60")))
  })

  it("falls back unrecognized layout to bubble_br", () => {
    const plan = computeMergePlan({
      dIntroMs: 10000,
      dRecMs: 5000,
      maxStretch: 2.5,
      pipScale: 0.2,
      layout: "typo_layout",
    })

    assert.equal(plan.layout, "bubble_br")
    assert.ok(plan.warnings.some((w) => w.includes("bubble_br")))
  })

  it("computes offsets for all overlay layouts", () => {
    const cases: Array<[string, number, number]> = [
      ["bubble_br", 1920 - 384 - 48, 1080 - 384 - 48],
      ["bubble_bl", 48, 1080 - 384 - 48],
      ["bubble_tr", 1920 - 384 - 48, 48],
      ["bubble_tl", 48, 48],
    ]

    for (const [layout, ox, oy] of cases) {
      const plan = computeMergePlan({
        dIntroMs: 10000,
        dRecMs: 5000,
        maxStretch: 2.5,
        pipScale: 0.2,
        layout,
      })
      assert.equal(plan.ox, ox, layout)
      assert.equal(plan.oy, oy, layout)
    }
  })

  it("rect_br uses a rectangular overlay without circular mask filters", () => {
    const plan = computeMergePlan({
      dIntroMs: 10000,
      dRecMs: 5000,
      maxStretch: 2.5,
      pipScale: 0.2,
      layout: "rect_br",
    })

    assert.equal(plan.circular, false)

    const args = buildMergeArgs({
      recordingPath: "/rec.mp4",
      introPath: "/intro.mp4",
      outputPath: "/out.mp4",
      plan,
    })
    const filter = args[args.indexOf("-filter_complex") + 1]!
    assert.ok(!filter.includes("alphamerge"))
    assert.ok(!filter.includes("geq"))
  })

  it("fullscreen_intro uses concat with setsar and aformat on both audio chains", () => {
    const plan = computeMergePlan({
      dIntroMs: 3000,
      dRecMs: 5000,
      maxStretch: 2.5,
      pipScale: 0.2,
      layout: "fullscreen_intro",
    })

    assert.equal(plan.isFullscreenIntro, true)
    assert.equal(plan.stretchFactor, 1)
    assert.equal(plan.targetMs, 8000)

    const args = buildMergeArgs({
      recordingPath: "/rec.mp4",
      introPath: "/intro.mp4",
      outputPath: "/out.mp4",
      plan,
    })
    const filter = args[args.indexOf("-filter_complex") + 1]!
    assert.match(filter, /setsar=1/)
    assert.match(filter, /aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo/)
    assert.match(filter, /anullsrc=r=48000:cl=stereo,atrim=0:5\.000/)
    assert.match(filter, /concat=n=2:v=1:a=0/)
    assert.ok(!args.includes("-t"))
  })
})
