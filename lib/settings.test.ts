import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { parseStoredSetting } from "@/lib/settings"
import { SETTING_DEFAULTS, SETTING_KEYS } from "@/lib/settings-schema"

describe("parseStoredSetting round-trip", () => {
  for (const key of SETTING_KEYS) {
    it(`parses non-default for ${key}`, () => {
      const defaultValue = SETTING_DEFAULTS[key]
      const nonDefault =
        typeof defaultValue === "boolean"
          ? !defaultValue
          : typeof defaultValue === "string"
            ? "bubble_tl"
            : defaultValue + 1

      if (key === "merge.layout") {
        const parsed = parseStoredSetting(key, "bubble_tl")
        assert.equal(parsed, "bubble_tl")
        return
      }

      const parsed = parseStoredSetting(key, nonDefault)
      assert.notEqual(parsed, undefined)
      assert.equal(parsed, nonDefault)
    })
  }

  it("parses cleanup.enabled=false", () => {
    assert.equal(parseStoredSetting("cleanup.enabled", false), false)
    assert.equal(parseStoredSetting("cleanup.enabled", "false"), false)
  })
})
