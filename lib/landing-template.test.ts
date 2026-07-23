import { strict as assert } from "node:assert"
import { describe, it } from "node:test"

import {
  DEFAULT_LANDING_TEMPLATE,
  SAMPLE_LEAD,
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

  it("substitutes into the default landing template without leftover tokens", () => {
    const result = substituteTemplate(
      DEFAULT_LANDING_TEMPLATE,
      sampleValuesFor(SAMPLE_LEAD, {
        cta_url: "https://example.com/book",
        cta_label: "Book a call",
      }),
    )

    assert.ok(!/\{\{[a-z_]+\}\}/.test(result))
    assert.match(result, /<video controls playsinline preload="metadata">/)
    assert.match(result, /noindex, nofollow/)
  })
})
