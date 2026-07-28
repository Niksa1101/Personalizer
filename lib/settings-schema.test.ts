import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  keysForGroup,
  MERGE_LAYOUTS,
  SETTING_DEFAULTS,
  SETTING_FIELDS,
  SETTING_GROUPS,
  SETTING_KEYS,
  settingSchemaFor,
} from "@/lib/settings-schema"

describe("BOOLEAN_SETTING", () => {
  const schema = settingSchemaFor("deploy.dry_run")

  it('parse("false") === false — z.coerce.boolean() would return true', () => {
    assert.equal(schema.parse("false"), false)
  })

  it("accepts jsonb round-trip and form strings", () => {
    assert.equal(schema.parse(false), false)
    assert.equal(schema.parse("true"), true)
    assert.equal(schema.parse(true), true)
  })

  it("rejects non-boolean strings and numbers", () => {
    assert.equal(schema.safeParse("not-a-boolean").success, false)
    assert.equal(schema.safeParse("").success, false)
    assert.equal(schema.safeParse("0").success, false)
    assert.equal(schema.safeParse(1).success, false)
  })
})

describe("settingSchemaFor", () => {
  for (const key of SETTING_KEYS) {
    it(`accepts default for ${key}`, () => {
      const parsed = settingSchemaFor(key).safeParse(SETTING_DEFAULTS[key])
      assert.equal(parsed.success, true)
    })
  }

  it("rejects merge.pip_scale below min and above max", () => {
    const schema = settingSchemaFor("merge.pip_scale")
    assert.equal(schema.safeParse(0.04).success, false)
    assert.equal(schema.safeParse(0.61).success, false)
  })

  it("rejects non-integer queue.concurrency", () => {
    const schema = settingSchemaFor("queue.concurrency")
    assert.equal(schema.safeParse(1.5).success, false)
    assert.equal(schema.safeParse(0).success, false)
    assert.equal(schema.safeParse(5).success, false)
  })

  it("merge.layout accepts all six layouts", () => {
    const schema = settingSchemaFor("merge.layout")
    for (const layout of MERGE_LAYOUTS) {
      assert.equal(schema.safeParse(layout).success, true)
    }
    assert.equal(schema.safeParse("invalid_layout").success, false)
  })
})

describe("keysForGroup", () => {
  it("partitions SETTING_KEYS exactly once", () => {
    const seen = new Set<string>()
    for (const group of SETTING_GROUPS) {
      for (const key of keysForGroup(group)) {
        assert.equal(SETTING_FIELDS[key].group, group)
        assert.equal(seen.has(key), false)
        seen.add(key)
      }
    }
    assert.equal(seen.size, SETTING_KEYS.length)
  })
})
