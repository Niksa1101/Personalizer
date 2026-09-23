import { strict as assert } from "node:assert"
import { describe, it } from "node:test"

import { withTranscodeLock } from "./mutex"

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe("withTranscodeLock", () => {
  it("runs transcodes one at a time, in submission order", async () => {
    const events: string[] = []
    let running = 0
    let maxRunning = 0

    const job = (name: string, ms: number) =>
      withTranscodeLock(async () => {
        running += 1
        maxRunning = Math.max(maxRunning, running)
        events.push(`start ${name}`)
        await tick(ms)
        events.push(`end ${name}`)
        running -= 1
        return name
      })

    // The slow job is submitted first; a naive Promise.all would let b and c overtake it.
    const results = await Promise.all([job("a", 30), job("b", 5), job("c", 1)])

    assert.deepEqual(results, ["a", "b", "c"])
    assert.equal(maxRunning, 1)
    assert.deepEqual(events, ["start a", "end a", "start b", "end b", "start c", "end c"])
  })

  it("keeps the queue alive after a failed transcode", async () => {
    const failed = withTranscodeLock(async () => {
      throw new Error("ffmpeg exited 1")
    })
    const next = withTranscodeLock(async () => "still runs")

    await assert.rejects(failed, /ffmpeg exited 1/)
    assert.equal(await next, "still runs")
  })
})
