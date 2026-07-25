import { strict as assert } from "node:assert"
import { describe, it } from "node:test"

import {
  applyPosterFallback,
  deriveCtaHref,
  dropEmptyAnchors,
  escapeHtml,
  landingPath,
  normalizeLf,
  renderLandingHtml,
  safeUrl,
} from "./landing-page"
import { SAMPLE_LEAD, sampleValuesFor } from "./landing-template"

describe("escapeHtml", () => {
  it("escapes characters unsafe in text and quoted attributes", () => {
    assert.equal(
      escapeHtml(`Tom & Jerry <script>alert("x")</script> 'quote'`),
      "Tom &amp; Jerry &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &#39;quote&#39;",
    )
  })
})

describe("safeUrl", () => {
  it("allows http and https", () => {
    assert.equal(safeUrl("https://example.com/v"), "https://example.com/v")
  })

  it("allows inline data images for preview posters", () => {
    assert.match(
      safeUrl("data:image/jpeg;base64,abc"),
      /^data:image\/jpeg;base64,/,
    )
  })

  it("rejects javascript: and other schemes", () => {
    assert.equal(safeUrl("javascript:alert(1)"), "")
    assert.equal(safeUrl("ftp://example.com"), "")
  })

  it("escapes quotes and angle brackets in accepted URLs", () => {
    assert.equal(
      safeUrl('https://e.com/x" onmouseover="alert(document.cookie)'),
      "https://e.com/x&quot; onmouseover=&quot;alert(document.cookie)",
    )
    assert.equal(
      safeUrl("https://x.com/a<script>alert(1)</script>"),
      "https://x.com/a&lt;script&gt;alert(1)&lt;/script&gt;",
    )
  })

  it("allows mailto and tel for CTA when enabled", () => {
    assert.equal(
      safeUrl("mailto:a@b.com", { allowContactSchemes: true }),
      "mailto:a@b.com",
    )
    assert.equal(
      safeUrl("tel:+15551234567", { allowContactSchemes: true }),
      "tel:+15551234567",
    )
  })
})

describe("deriveCtaHref", () => {
  it("prefixes bare email and phone values", () => {
    assert.equal(deriveCtaHref("email", "alex@example.com"), "mailto:alex@example.com")
    assert.equal(deriveCtaHref("phone", "+1 555 123 4567"), "tel:+1 555 123 4567")
  })

  it("passes through website and calendar URLs", () => {
    assert.equal(
      deriveCtaHref("website", "https://example.com/book"),
      "https://example.com/book",
    )
  })
})

describe("dropEmptyAnchors", () => {
  it("removes anchors with empty href and their text", () => {
    const html = '<p>Before</p><a href="" class="cta">Book</a><p>After</p>'
    assert.equal(dropEmptyAnchors(html), "<p>Before</p><p>After</p>")
  })
})

describe("applyPosterFallback", () => {
  it("strips empty poster and downgrades preload when poster is absent", () => {
    const html =
      '<video controls playsinline preload="none" poster=""><source></video>'
    const result = applyPosterFallback(html)
    assert.ok(!result.includes('poster=""'))
    assert.match(result, /preload="metadata"/)
  })

  it("keeps preload none when poster is present", () => {
    const html =
      '<video controls playsinline preload="none" poster="https://cdn/p.jpg"><source></video>'
    assert.match(applyPosterFallback(html), /preload="none"/)
  })
})

describe("normalizeLf", () => {
  it("converts CRLF and CR to LF", () => {
    assert.equal(normalizeLf("a\r\nb\rc"), "a\nb\nc")
  })
})

describe("landingPath", () => {
  it("derives /{campaign}/{lead} with no trailing slash", () => {
    assert.equal(landingPath("acme-outreach", "acme-plumbing-portland"), "/acme-outreach/acme-plumbing-portland")
  })
})

describe("renderLandingHtml", () => {
  const baseValues = sampleValuesFor(SAMPLE_LEAD, {
    cta_url: "https://example.com/book",
    cta_label: "Book a call",
  })

  it("escapes lead values in element text and attributes", () => {
    const html = renderLandingHtml(
      "<p>{{company}}</p><a href=\"{{website_url}}\">{{first_name}}</a>",
      {
        ...baseValues,
        company: 'Evil & Co <img src=x onerror=alert(1)>',
        first_name: 'Tom "Danger" O\'Neil',
        website_url: "https://safe.example",
      },
    )
    assert.match(html, /Evil &amp; Co/)
    assert.ok(!html.includes("<img"))
    assert.match(html, /Tom &quot;Danger&quot; O&#39;Neil/)
  })

  it("rejects javascript: in URL placeholders", () => {
    const html = renderLandingHtml(
      '<a href="{{cta_url}}">Go</a>',
      { cta_url: "javascript:alert(1)", cta_label: "Go" },
      { cta_type: "custom" },
    )
    assert.ok(!html.includes("<a"))
    assert.ok(!html.includes("javascript:"))
  })

  it("escapes malicious characters in URL placeholders", () => {
    const html = renderLandingHtml(
      '<a class="cta" href="{{cta_url}}">Book</a><p>{{website_url}}</p><video poster="{{poster_url}}"></video>',
      {
        cta_url: 'https://e.com/x" onmouseover="alert(document.cookie)',
        cta_label: "Book",
        website_url: "https://x.com/a<script>alert(1)</script>",
        poster_url: 'https://s.co/p.jpg" onerror="alert(1)"',
      },
      { cta_type: "custom" },
    )
    assert.match(
      html,
      /href="https:\/\/e\.com\/x&quot; onmouseover=&quot;alert\(document\.cookie\)"/,
    )
    assert.match(html, /https:\/\/x\.com\/a&lt;script&gt;alert\(1\)&lt;\/script&gt;/)
    assert.match(
      html,
      /poster="https:\/\/s\.co\/p\.jpg&quot; onerror=&quot;alert\(1\)&quot;"/,
    )
  })

  it("derives mailto CTA from email type", () => {
    const html = renderLandingHtml(
      '<a href="{{cta_url}}">{{cta_label}}</a>',
      { cta_url: "alex@example.com", cta_label: "Email me" },
      { cta_type: "email" },
    )
    assert.match(html, /href="mailto:alex@example.com"/)
  })

  it("renders unknown placeholders empty", () => {
    const html = renderLandingHtml("{{unknown_token}}", baseValues)
    assert.equal(html, "")
  })

  it("normalizes CRLF in output", () => {
    const html = renderLandingHtml("line1\r\nline2", {})
    assert.equal(html, "line1\nline2")
  })
})
