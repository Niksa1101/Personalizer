import { strict as assert } from "node:assert"
import { describe, it } from "node:test"

import { SLUG_REGEX, leadSlug, slugFromName } from "./slug"

describe("slugFromName", () => {
  it("lowercases and hyphenates, collapsing runs and trimming edges", () => {
    assert.equal(slugFromName("  Acme Dental & Co.  "), "acme-dental-co")
    assert.equal(slugFromName("Joe's -- Pizza!!"), "joe-s-pizza")
  })

  it("drops non-ASCII letters rather than emitting unsafe path characters", () => {
    assert.equal(slugFromName("Čačak Frizer Šik"), "a-ak-frizer-ik")
  })

  it("always produces a value matching SLUG_REGEX or the empty string", () => {
    for (const name of ["Hello World", "---", "A1 B2 C3", "ÄÖÜ", "x"]) {
      const slug = slugFromName(name)
      assert.ok(slug === "" || SLUG_REGEX.test(slug), `${name} → ${slug}`)
    }
  })
})

describe("leadSlug", () => {
  const id = "3f2b9c1e-7a44-4b21-9d0e-123456789abc"

  it("prefers company, appends city and an 8-char id suffix", () => {
    assert.equal(
      leadSlug({ id, company: "Acme Dental", full_name: "Jane Doe", city: "Austin" }),
      "acme-dental-austin-3f2b9c1e",
    )
  })

  it("falls back to the contact name when company is missing", () => {
    assert.equal(
      leadSlug({ id, company: null, full_name: "Jane Doe", city: null }),
      "jane-doe-3f2b9c1e",
    )
  })

  it("uses only the id suffix when there is nothing sluggable", () => {
    assert.equal(leadSlug({ id, company: "!!!", full_name: null, city: null }), "3f2b9c1e")
  })

  it("gives same-named leads distinct storage paths", () => {
    const a = leadSlug({ id, company: "Acme", full_name: null, city: "Austin" })
    const b = leadSlug({
      id: "9a8b7c6d-0000-0000-0000-000000000000",
      company: "Acme",
      full_name: null,
      city: "Austin",
    })
    assert.notEqual(a, b)
  })
})
