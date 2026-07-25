import { strict as assert } from "node:assert"
import { describe, it } from "node:test"

import { renderLandingHtml } from "./landing-page"
import {
  DEFAULT_LANDING_TEMPLATE,
  SAMPLE_LEAD,
  SAMPLE_POSTER_URL,
  SAMPLE_VIDEO_URL,
  substituteTemplate,
  TEMPLATE_PLACEHOLDERS,
  sampleValuesFor,
} from "./landing-template"

describe("substituteTemplate", () => {
  const values = sampleValuesFor(SAMPLE_LEAD, {
    cta_url: "https://example.com/book",
    cta_label: "Book a call",
  })

  it("substitutes every §5.1.1 placeholder", () => {
    const html = TEMPLATE_PLACEHOLDERS.map((token) => `{{${token}}}`).join(" ")
    const result = substituteTemplate(html, values)

    for (const token of TEMPLATE_PLACEHOLDERS) {
      assert.ok(
        !result.includes(`{{${token}}}`),
        `placeholder {{${token}}} should be replaced`,
      )
    }

    assert.match(result, /Alex/)
    assert.match(result, /Acme Plumbing/)
    assert.ok(result.includes(SAMPLE_VIDEO_URL))
    assert.ok(result.includes(SAMPLE_POSTER_URL))
    assert.match(result, /Book a call/)
  })

  it("renders unknown placeholders as empty string", () => {
    const result = substituteTemplate(
      "Hello {{unknown_token}} world",
      values,
    )
    assert.equal(result, "Hello  world")
  })

  it("renders missing values as empty string, never literal tokens", () => {
    const sparse = sampleValuesFor({
      ...SAMPLE_LEAD,
      email: null,
      phone: null,
      industry: null,
    })

    const html =
      "{{email}} {{phone}} {{industry}} {{missing_field}} {{company}}"
    const result = substituteTemplate(html, sparse)

    assert.equal(result, "    Acme Plumbing")
    assert.ok(!result.includes("{{"))
  })
})

describe("renderLandingHtml with default template", () => {
  it("substitutes into the default landing template without leftover tokens", () => {
    const result = renderLandingHtml(
      DEFAULT_LANDING_TEMPLATE,
      sampleValuesFor(SAMPLE_LEAD, {
        cta_url: "https://example.com/book",
        cta_label: "Book a call",
      }),
      { cta_type: "website" },
    )

    assert.ok(!/\{\{[a-z_]+\}\}/.test(result))
    assert.match(result, /<video controls playsinline preload="none"/)
    assert.match(result, /poster="data:image\/jpeg;base64,/)
    assert.match(result, /noindex, nofollow/)
  })
})
