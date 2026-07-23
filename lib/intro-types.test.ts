import { strict as assert } from "node:assert"
import { describe, it } from "node:test"

import {
  assignIntroSchema,
  nameFromFilename,
  renameIntroSchema,
} from "./intro-types"

describe("nameFromFilename", () => {
  it("strips extension case-insensitively", () => {
    assert.equal(nameFromFilename("Pitch v2.MP4"), "Pitch v2")
  })

  it("uses basename when path segments are present", () => {
    assert.equal(nameFromFilename("uploads/my-intro.webm"), "my-intro")
  })

  it("returns the full name when there is no extension", () => {
    assert.equal(nameFromFilename("Pitch"), "Pitch")
  })
})

describe("renameIntroSchema", () => {
  it("accepts a trimmed name within bounds", () => {
    const result = renameIntroSchema.safeParse({
      id: "550e8400-e29b-41d4-a716-446655440000",
      name: "  Q3 pitch  ",
    })
    assert.equal(result.success, true)
    if (result.success) {
      assert.equal(result.data.name, "Q3 pitch")
    }
  })

  it("rejects empty names", () => {
    const result = renameIntroSchema.safeParse({
      id: "550e8400-e29b-41d4-a716-446655440000",
      name: "   ",
    })
    assert.equal(result.success, false)
  })
})

describe("assignIntroSchema", () => {
  it("requires at least one campaign", () => {
    const result = assignIntroSchema.safeParse({
      introId: "550e8400-e29b-41d4-a716-446655440000",
      campaignIds: [],
    })
    assert.equal(result.success, false)
  })

  it("accepts valid uuids", () => {
    const result = assignIntroSchema.safeParse({
      introId: "550e8400-e29b-41d4-a716-446655440000",
      campaignIds: ["6ba7b810-9dad-11d1-80b4-00c04fd430c8"],
    })
    assert.equal(result.success, true)
  })
})
