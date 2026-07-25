import { strict as assert } from "node:assert"
import { describe, it } from "node:test"

import { robotsTxtBody } from "./robots-txt"

describe("robotsTxtBody", () => {
  it("disallows all crawlers from the entire site", () => {
    assert.equal(robotsTxtBody(), "User-agent: *\nDisallow: /\n")
  })
})
