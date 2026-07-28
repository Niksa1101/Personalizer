import { describe, it } from "node:test"
import assert from "node:assert/strict"

import {
  buildLeadSearchOrFilter,
  escapeIlikePattern,
  quotePostgrestValue,
} from "@/lib/lead-filters"

describe("escapeIlikePattern", () => {
  it("escapes wildcard characters", () => {
    assert.equal(escapeIlikePattern("50%"), "50\\%")
    assert.equal(escapeIlikePattern("a_b"), "a\\_b")
    assert.equal(escapeIlikePattern("a\\b"), "a\\\\b")
  })
})

describe("quotePostgrestValue", () => {
  it("wraps values in double quotes", () => {
    assert.equal(quotePostgrestValue("plain"), '"plain"')
    assert.equal(quotePostgrestValue('say "hi"'), '"say \\"hi\\""')
  })
})

describe("buildLeadSearchOrFilter", () => {
  it("quotes ilike patterns for literal percent search", () => {
    const filter = buildLeadSearchOrFilter("50%")
    assert.match(filter, /company\.ilike\."%50\\\\%%"/)
    assert.match(filter, /full_name\.ilike\."%50\\\\%%"/)
  })

  it("quotes ilike patterns for literal underscore search", () => {
    const filter = buildLeadSearchOrFilter("a_b")
    assert.match(filter, /company\.ilike\."%a\\\\_b%"/)
  })

  it("quotes ilike patterns for comma-containing search", () => {
    const filter = buildLeadSearchOrFilter("Acme, Inc")
    assert.match(filter, /company\.ilike\."%Acme, Inc%"/)
    assert.doesNotMatch(filter, /\\,/)
  })
})
