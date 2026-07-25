import { strict as assert } from "node:assert"
import { describe, it } from "node:test"

import { derivePosterStorageKey } from "./upload"

describe("derivePosterStorageKey", () => {
  it("derives poster.jpg from final.mp4", () => {
    assert.equal(
      derivePosterStorageKey("abc-123/final.mp4"),
      "abc-123/poster.jpg",
    )
  })

  it("throws when the web storage key does not end with /final.mp4", () => {
    assert.throws(
      () => derivePosterStorageKey("abc-123/poster.jpg"),
      /Cannot derive poster storage key/,
    )
  })
})
