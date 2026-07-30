import { describe, it } from "node:test"
import assert from "node:assert/strict"

import { escapeCsvCell, toCsv } from "@/lib/csv"

describe("escapeCsvCell", () => {
  it("quotes null and empty as empty quoted field", () => {
    assert.equal(escapeCsvCell(null), '""')
    assert.equal(escapeCsvCell(undefined), '""')
    assert.equal(escapeCsvCell(""), '""')
  })

  it("quotes plain text unconditionally", () => {
    assert.equal(escapeCsvCell("hello"), '"hello"')
  })

  it("doubles embedded quotes", () => {
    assert.equal(escapeCsvCell('say "hi"'), '"say ""hi"""')
  })

  it("preserves embedded commas inside quotes", () => {
    assert.equal(escapeCsvCell("a,b"), '"a,b"')
  })

  it("preserves embedded CRLF inside quotes", () => {
    assert.equal(escapeCsvCell("a\r\nb"), '"a\r\nb"')
  })

  for (const ch of ["=", "+", "-", "@", "\t", "\r"] as const) {
    it(`prefixes formula injection character ${JSON.stringify(ch)}`, () => {
      const value = `${ch}SUM(A1)`
      assert.equal(escapeCsvCell(value), `"'${value}"`)
    })
  }
})

describe("toCsv", () => {
  it("uses CRLF line endings only", () => {
    const csv = toCsv(["a"], [["b"]])
    assert.match(csv, /\r\n/)
    assert.doesNotMatch(csv.replace(/\r\n/g, ""), /\n/)
  })

  it("terminates the last record with CRLF", () => {
    const csv = toCsv(["h"], [["v"]])
    assert.ok(csv.endsWith("\r\n"))
  })
})
