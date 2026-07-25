import { strict as assert } from "node:assert"
import { describe, it } from "node:test"

import { renderLandingHtml } from "./landing-page"
import {
  DEFAULT_LANDING_TEMPLATE,
  hasPlaceholder,
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

  it("matches placeholders with surrounding whitespace and mixed case", () => {
    const result = substituteTemplate(
      "{{ first_name }} {{Company}} {{FIRST_NAME}}",
      values,
    )
    assert.equal(result, "Alex Acme Plumbing Alex")
  })

  it("renders non-canonical spellings empty", () => {
    const result = substituteTemplate("{{firstName}}", values)
    assert.equal(result, "")
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

describe("hasPlaceholder", () => {
  it("accepts the same spellings substituteTemplate resolves", () => {
    for (const template of [
      "<source src={{video_url}}>",
      "<source src={{ video_url }}>",
      "<source src={{VIDEO_URL}}>",
      "<source src={{ Video_Url }}>",
    ]) {
      assert.ok(hasPlaceholder(template, "video_url"), template)
      assert.ok(!substituteTemplate(template, { video_url: "x" }).includes("{{"))
    }
  })

  it("does not match a different or non-canonical token", () => {
    assert.ok(!hasPlaceholder("{{poster_url}}", "video_url"))
    assert.ok(!hasPlaceholder("{{videoUrl}}", "video_url"))
    assert.ok(!hasPlaceholder("no placeholders here", "video_url"))
  })

  it("finds a token that is not the first placeholder in the template", () => {
    assert.ok(hasPlaceholder("{{company}} {{city}} {{ cta_url }}", "cta_url"))
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
