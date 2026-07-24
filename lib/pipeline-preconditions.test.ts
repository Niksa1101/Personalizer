import { strict as assert } from "node:assert"
import { describe, it } from "node:test"

import { mergePrecondition } from "./pipeline-preconditions"

describe("mergePrecondition", () => {
  it("pauses when the campaign has no intro", () => {
    assert.equal(
      mergePrecondition({
        hasIntro: false,
        hasUsableRecording: true,
        alreadyRedirected: false,
      }),
      "pause_intro_missing",
    )
  })

  it("record-first when intro exists but no usable recording", () => {
    assert.equal(
      mergePrecondition({
        hasIntro: true,
        hasUsableRecording: false,
        alreadyRedirected: false,
      }),
      "record_first",
    )
  })

  it("proceeds when intro and recording are present", () => {
    assert.equal(
      mergePrecondition({
        hasIntro: true,
        hasUsableRecording: true,
        alreadyRedirected: false,
      }),
      "proceed",
    )
  })

  it("proceeds on second merge visit even without a usable recording", () => {
    assert.equal(
      mergePrecondition({
        hasIntro: true,
        hasUsableRecording: false,
        alreadyRedirected: true,
      }),
      "proceed",
    )
  })

  it("still pauses for missing intro after a recording redirect", () => {
    assert.equal(
      mergePrecondition({
        hasIntro: false,
        hasUsableRecording: false,
        alreadyRedirected: true,
      }),
      "pause_intro_missing",
    )
  })
})
