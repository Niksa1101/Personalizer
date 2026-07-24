import { strict as assert } from "node:assert"
import { describe, it } from "node:test"

import { classifyCaptureError } from "./classify"

const basePage = {
  innerTextLength: 500,
  scrollHeight: 3000,
  viewportHeight: 1080,
  finalUrl: "https://example.com",
  bodyHtml: "<html><body>Welcome to our business</body></html>",
}

describe("classifyCaptureError", () => {
  it("classifies dns failures", () => {
    assert.equal(
      classifyCaptureError({
        url: "https://dead.invalid",
        err: new Error("getaddrinfo ENOTFOUND dead.invalid"),
      }),
      "dns_failure",
    )
  })

  it("classifies connection refused", () => {
    assert.equal(
      classifyCaptureError({
        url: "https://example.com",
        err: new Error("connect ECONNREFUSED"),
      }),
      "connection_refused",
    )
  })

  it("classifies ssl errors", () => {
    assert.equal(
      classifyCaptureError({
        url: "https://example.com",
        err: new Error("ERR_CERT_AUTHORITY_INVALID"),
      }),
      "ssl_error",
    )
  })

  it("classifies http 404 as http_4xx", () => {
    assert.equal(
      classifyCaptureError({
        url: "https://example.com",
        httpStatus: 404,
        page: basePage,
      }),
      "http_4xx",
    )
  })

  it("classifies http 5xx", () => {
    assert.equal(
      classifyCaptureError({
        url: "https://example.com",
        httpStatus: 503,
        page: basePage,
      }),
      "http_5xx",
    )
  })

  it("classifies parked domains", () => {
    assert.equal(
      classifyCaptureError({
        url: "https://example.com",
        page: {
          ...basePage,
          bodyHtml: "<html><body>This domain is for sale</body></html>",
        },
      }),
      "parked_domain",
    )
  })

  it("classifies empty pages", () => {
    assert.equal(
      classifyCaptureError({
        url: "https://example.com",
        page: {
          ...basePage,
          innerTextLength: 50,
          scrollHeight: 1000,
          viewportHeight: 1080,
        },
      }),
      "empty_page",
    )
  })

  it("classifies social hosts as not_a_website", () => {
    assert.equal(
      classifyCaptureError({
        url: "https://www.facebook.com/acme",
        page: {
          ...basePage,
          finalUrl: "https://www.facebook.com/acme",
        },
      }),
      "not_a_website",
    )
  })

  it("classifies bot detection markers", () => {
    assert.equal(
      classifyCaptureError({
        url: "https://example.com",
        page: {
          ...basePage,
          bodyHtml: "<html><body>Checking your browser before accessing</body></html>",
        },
      }),
      "bot_detected",
    )
  })

  it("classifies captcha iframes", () => {
    assert.equal(
      classifyCaptureError({
        url: "https://example.com",
        page: {
          ...basePage,
          bodyHtml: '<iframe src="https://recaptcha.net"></iframe>',
        },
      }),
      "captcha",
    )
  })

  it("classifies geo blocks on 403", () => {
    assert.equal(
      classifyCaptureError({
        url: "https://example.com",
        httpStatus: 403,
        page: {
          ...basePage,
          bodyHtml: "<html><body>Not available in your country</body></html>",
        },
      }),
      "geo_blocked",
    )
  })

  it("classifies login redirects", () => {
    assert.equal(
      classifyCaptureError({
        url: "https://example.com",
        page: {
          ...basePage,
          finalUrl: "https://example.com/login?next=/",
        },
      }),
      "login_required",
    )
  })

  it("classifies navigation timeouts", () => {
    assert.equal(
      classifyCaptureError({
        url: "https://example.com",
        err: new Error("Navigation timeout of 30000 ms exceeded"),
      }),
      "nav_timeout",
    )
  })

  it("classifies browser crashes", () => {
    assert.equal(
      classifyCaptureError({
        url: "https://example.com",
        err: new Error("Target crashed"),
      }),
      "browser_crash",
    )
  })
})
