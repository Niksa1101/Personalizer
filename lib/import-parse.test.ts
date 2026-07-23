import { strict as assert } from "node:assert"
import { describe, it } from "node:test"

import {
  classify,
  detectDelimiter,
  detectHeaderMapping,
  isSocialOrDirectory,
  normalizeWebsiteUrl,
  parseCsv,
  stripBom,
} from "./import-parse"
import { UNMAPPED } from "./import-types"

describe("detectDelimiter", () => {
  it("picks the delimiter with the highest count", () => {
    assert.equal(detectDelimiter("a;b;c;d"), ";")
    assert.equal(detectDelimiter("a\tb\tc"), "\t")
  })

  it("ties resolve to comma", () => {
    assert.equal(detectDelimiter("a,b;c"), ",")
  })
})

describe("stripBom", () => {
  it("strips UTF-8 BOM and sets hadBom", () => {
    const { text, hadBom } = stripBom("\uFEFFname,url\nAcme,https://acme.com")
    assert.equal(hadBom, true)
    assert.equal(text.startsWith("name"), true)
  })
})

describe("parseCsv", () => {
  it("keeps quoted fields with embedded delimiters and newlines as one row", () => {
    const csv = 'company,notes\nAcme,"line one; line two\nstill one field"'
    const { headers, records, lineNumbers } = parseCsv(csv, ",")
    assert.deepEqual(headers, ["company", "notes"])
    assert.equal(records.length, 1)
    assert.equal(records[0]![1], "line one; line two\nstill one field")
    assert.equal(lineNumbers[0], 2)
  })

  it("reports 1-based line numbers including the header", () => {
    const csv = "a,b\n1,2\n3,4"
    const { lineNumbers } = parseCsv(csv, ",")
    assert.deepEqual(lineNumbers, [2, 3])
  })
})

describe("classify", () => {
  const headers = ["company", "website", "email"]
  const mapping = detectHeaderMapping(headers)

  it("rejects ragged rows at the text-editor line number", () => {
    const { rejectedRows } = classify(
      headers,
      [["Acme", "https://acme.com"]],
      [3],
      mapping,
    )
    assert.equal(rejectedRows.length, 1)
    assert.equal(rejectedRows[0]!.row, 3)
    assert.match(rejectedRows[0]!.reason, /ragged row/)
  })

  it("rejects unparseable URLs when no email is present", () => {
    const { rejectedRows } = classify(
      headers,
      [["Acme", "not a url!!", ""]],
      [2],
      mapping,
    )
    assert.equal(rejectedRows.length, 1)
    assert.match(rejectedRows[0]!.reason, /unparseable/)
  })
})

describe("normalizeWebsiteUrl", () => {
  it("adds https, lowercases host, keeps www, strips tracking params", () => {
    const url = normalizeWebsiteUrl(
      "WWW.Example.COM/path?utm_source=x&fbclid=abc",
    )
    assert.equal(url, "https://www.example.com/path")
  })

  it("drops trailing slash on bare-host URLs", () => {
    assert.equal(normalizeWebsiteUrl("example.com/"), "https://example.com")
  })

  it("returns null for unparseable input", () => {
    assert.equal(normalizeWebsiteUrl(":::bad"), null)
  })
})

describe("isSocialOrDirectory", () => {
  it("matches social hosts by suffix", () => {
    assert.equal(isSocialOrDirectory("https://m.facebook.com/acme"), true)
    assert.equal(isSocialOrDirectory("https://facebook.com/acme"), true)
  })

  it("matches directory hosts including path patterns", () => {
    assert.equal(isSocialOrDirectory("https://www.yelp.com/biz/acme"), true)
    assert.equal(
      isSocialOrDirectory("https://google.com/maps/place/acme"),
      true,
    )
  })

  it("does not match ordinary business sites", () => {
    assert.equal(isSocialOrDirectory("https://www.acme-plumbing.com"), false)
  })
})

describe("detectHeaderMapping", () => {
  it("maps known aliases and leaves unknown columns unmapped", () => {
    const mapping = detectHeaderMapping(["Company", "Website URL", "Extra"])
    assert.equal(mapping["Company"], "company")
    assert.equal(mapping["Website URL"], "website_url")
    assert.equal(mapping["Extra"], UNMAPPED)
  })
})
