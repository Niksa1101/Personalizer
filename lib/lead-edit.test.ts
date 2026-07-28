import { describe, it } from "node:test"
import assert from "node:assert/strict"

import { leadEditSchema } from "@/lib/lead-edit"

const base = {
  first_name: "",
  last_name: "",
  full_name: "",
  company: "",
  email: "",
  phone: "",
  website_url: "",
  city: "",
  state: "",
  country: "",
  merge_layout: "",
  pip_scale: "",
  leads_updated_at: new Date().toISOString(),
}

describe("leadEditSchema", () => {
  it("maps empty strings to null for nullable text fields", () => {
    const parsed = leadEditSchema.parse(base)
    assert.equal(parsed.first_name, null)
    assert.equal(parsed.last_name, null)
    assert.equal(parsed.full_name, null)
    assert.equal(parsed.company, null)
    assert.equal(parsed.email, null)
    assert.equal(parsed.phone, null)
    assert.equal(parsed.website_url, null)
    assert.equal(parsed.city, null)
    assert.equal(parsed.state, null)
    assert.equal(parsed.country, null)
    assert.equal(parsed.merge_layout, null)
    assert.equal(parsed.pip_scale, null)
  })

  it("trims non-empty values", () => {
    const parsed = leadEditSchema.parse({
      ...base,
      company: "  Acme  ",
      website_url: " https://acme.example.com ",
    })
    assert.equal(parsed.company, "Acme")
    assert.equal(parsed.website_url, "https://acme.example.com")
  })

  it("rejects pip_scale below 0.05", () => {
    assert.throws(() =>
      leadEditSchema.parse({ ...base, pip_scale: "0.04" }),
    )
  })

  it("rejects pip_scale above 0.60", () => {
    assert.throws(() =>
      leadEditSchema.parse({ ...base, pip_scale: "0.61" }),
    )
  })

  it("accepts pip_scale within campaign bounds", () => {
    const parsed = leadEditSchema.parse({ ...base, pip_scale: "0.25" })
    assert.equal(parsed.pip_scale, 0.25)
  })
})
