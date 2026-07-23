import { strict as assert } from "node:assert"
import { describe, it } from "node:test"

import { formatFileSize, formatIntroDuration } from "./intro-format"

describe("formatIntroDuration", () => {
  it("formats sub-minute durations in seconds", () => {
    assert.equal(formatIntroDuration(12_500), "13s")
  })

  it("formats minute durations as m:ss", () => {
    assert.equal(formatIntroDuration(92_000), "1:32")
  })
})

describe("formatFileSize", () => {
  it("formats megabytes with one decimal", () => {
    assert.equal(formatFileSize(52_428_800), "50.0 MB")
  })
})
