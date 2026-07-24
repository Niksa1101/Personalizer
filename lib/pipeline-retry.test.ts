import { strict as assert } from "node:assert"
import { describe, it } from "node:test"

import { ERROR_CODES } from "./pipeline-types"
import {
  BAD_WEBSITE_CODES,
  backoffMs,
  classifyFailure,
  hostFromLead,
  parseStubFailureHost,
} from "./pipeline-retry"

describe("classifyFailure", () => {
  it("treats bad_website bucket codes as terminal", () => {
    assert.equal(classifyFailure("dns_failure"), "terminal")
    assert.equal(classifyFailure("not_a_website"), "terminal")
  })

  it("treats blocked and system codes as retryable", () => {
    assert.equal(classifyFailure("nav_timeout"), "retryable")
    assert.equal(classifyFailure("ffmpeg_failure"), "retryable")
  })

  it("classifies every ERROR_CODES entry", () => {
    for (const code of ERROR_CODES) {
      const result = classifyFailure(code)
      assert.ok(result === "terminal" || result === "retryable", code)
    }
  })

  // Parity with error_code_bucket() bad_website list —
  // supabase/migrations/20260720120200_functions.sql:75
  it("BAD_WEBSITE_CODES matches error_code_bucket bad_website list", () => {
    const fromSql = [
      "dns_failure",
      "connection_refused",
      "ssl_error",
      "http_4xx",
      "http_5xx",
      "parked_domain",
      "empty_page",
      "not_a_website",
    ] as const
    assert.deepEqual([...BAD_WEBSITE_CODES].sort(), [...fromSql].sort())
  })
})

describe("backoffMs", () => {
  it("doubles per attempt from the base", () => {
    assert.equal(backoffMs(1, 30_000), 30_000)
    assert.equal(backoffMs(2, 30_000), 60_000)
    assert.equal(backoffMs(3, 200), 800)
  })
})

describe("parseStubFailureHost", () => {
  it("parses fail-{code}.test hosts", () => {
    assert.equal(parseStubFailureHost("fail-dns_failure.test"), "dns_failure")
    assert.equal(parseStubFailureHost("fail-nav_timeout.test"), "nav_timeout")
  })

  it("returns null for normal hosts", () => {
    assert.equal(parseStubFailureHost("acme.com"), null)
    assert.equal(parseStubFailureHost("fail-unknown_code.test"), null)
  })
})

describe("hostFromLead", () => {
  it("prefers domain over website URL", () => {
    assert.equal(
      hostFromLead("example.com", "https://other.test"),
      "example.com",
    )
  })

  it("extracts hostname from website URL", () => {
    assert.equal(hostFromLead(null, "https://fail-dns_failure.test/path"), "fail-dns_failure.test")
  })
})
