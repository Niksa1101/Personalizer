import { strict as assert } from "node:assert"
import { describe, it } from "node:test"

import { buildReconcileRows, joinSiteUrl } from "@/lib/deploy-reconcile"
import { landingPath } from "@/lib/landing-page"

describe("joinSiteUrl", () => {
  it("joins with exactly one slash", () => {
    assert.equal(
      joinSiteUrl("https://site.netlify.app", "/acme/lead-1"),
      "https://site.netlify.app/acme/lead-1",
    )
  })

  it("collapses a trailing slash on the site url", () => {
    assert.equal(
      joinSiteUrl("https://site.netlify.app/", "/acme/lead-1"),
      "https://site.netlify.app/acme/lead-1",
    )
    assert.equal(
      joinSiteUrl("https://site.netlify.app///", "/acme/lead-1"),
      "https://site.netlify.app/acme/lead-1",
    )
  })

  it("adds the leading slash when a path lacks one", () => {
    assert.equal(
      joinSiteUrl("https://site.netlify.app", "acme/lead-1"),
      "https://site.netlify.app/acme/lead-1",
    )
  })

  it("agrees with landingPath()", () => {
    assert.equal(
      joinSiteUrl("https://site.netlify.app", landingPath("acme", "lead-1")),
      "https://site.netlify.app/acme/lead-1",
    )
  })
})

describe("buildReconcileRows", () => {
  it("maps pages to page/lead/url triples", () => {
    const rows = buildReconcileRows(
      [
        { id: "LP-1", campaign_lead_id: "CL-1", path: "/acme/lead-1" },
        { id: "LP-2", campaign_lead_id: "CL-2", path: "/acme/lead-2" },
      ],
      "https://site.netlify.app/",
    )

    assert.deepEqual(rows, [
      {
        page_id: "LP-1",
        campaign_lead_id: "CL-1",
        netlify_url: "https://site.netlify.app/acme/lead-1",
      },
      {
        page_id: "LP-2",
        campaign_lead_id: "CL-2",
        netlify_url: "https://site.netlify.app/acme/lead-2",
      },
    ])
  })

  it("returns an empty payload for an empty manifest", () => {
    assert.deepEqual(buildReconcileRows([], "https://site.netlify.app"), [])
  })
})
