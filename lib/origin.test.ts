import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { originsMatch } from "./origin"

describe("originsMatch", () => {
  it("accepts localhost and 127.0.0.1 as equivalent loopback", () => {
    assert.equal(
      originsMatch("http://localhost:3000", "http://127.0.0.1:3000"),
      true,
    )
    assert.equal(
      originsMatch("http://127.0.0.1:3000", "http://localhost:3000"),
      true,
    )
  })

  it("rejects cross-origin requests", () => {
    assert.equal(
      originsMatch("http://evil.example:3000", "http://127.0.0.1:3000"),
      false,
    )
  })

  it("rejects loopback on a different port", () => {
    assert.equal(
      originsMatch("http://localhost:3001", "http://127.0.0.1:3000"),
      false,
    )
  })
})
