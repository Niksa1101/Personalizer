import { describe, it } from "node:test"
import assert from "node:assert/strict"

import {
  buildExportFilename,
  EXPORT_COLUMNS,
  formatIsoSeconds,
  parseExportParams,
} from "@/lib/export"

describe("EXPORT_COLUMNS", () => {
  it("has exactly 19 columns in Tech §12 order", () => {
    assert.equal(EXPORT_COLUMNS.length, 19)
    assert.deepEqual(
      EXPORT_COLUMNS.map((col) => col.header),
      [
        "ref",
        "first_name",
        "last_name",
        "full_name",
        "company",
        "email",
        "phone",
        "website_url",
        "city",
        "state",
        "country",
        "industry",
        "campaign",
        "campaign_ref",
        "landing_url",
        "video_url",
        "status",
        "deployed_at",
        "promoted_at",
      ],
    )
  })
})

describe("buildExportFilename", () => {
  const now = new Date("2026-07-29T14:03:21.123Z")

  it("uses all when no campaign", () => {
    assert.equal(
      buildExportFilename(null, ["ready"], now),
      "personalizer-all-ready-20260729-1403.csv",
    )
  })

  it("joins two statuses with +", () => {
    assert.equal(
      buildExportFilename("CMP-01", ["ready", "deployed"], now),
      "personalizer-CMP-01-ready+deployed-20260729-1403.csv",
    )
  })

  it("uses multi for three or more statuses", () => {
    assert.equal(
      buildExportFilename("CMP-01", ["ready", "deployed", "failed"], now),
      "personalizer-CMP-01-multi-20260729-1403.csv",
    )
  })

  it("uses UTC for the timestamp", () => {
    const localMidnight = new Date("2026-07-29T23:30:00+02:00")
    assert.equal(
      buildExportFilename(null, ["ready"], localMidnight),
      "personalizer-all-ready-20260729-2130.csv",
    )
  })
})

describe("parseExportParams", () => {
  it("defaults to ready", () => {
    const parsed = parseExportParams(new URLSearchParams())
    assert.ok(!("error" in parsed))
    if ("error" in parsed) return
    assert.deepEqual(parsed.statuses, ["ready"])
  })

  it("accepts comma-joined status", () => {
    const parsed = parseExportParams(
      new URLSearchParams({ status: "ready,deployed" }),
    )
    assert.ok(!("error" in parsed))
    if ("error" in parsed) return
    assert.deepEqual(parsed.statuses, ["ready", "deployed"])
  })

  it("accepts repeated status params", () => {
    const params = new URLSearchParams()
    params.append("status", "ready")
    params.append("status", "deployed")
    const parsed = parseExportParams(params)
    assert.ok(!("error" in parsed))
    if ("error" in parsed) return
    assert.deepEqual(parsed.statuses, ["ready", "deployed"])
  })

  it("rejects unknown status with valid list", () => {
    const parsed = parseExportParams(new URLSearchParams({ status: "bogus" }))
    assert.ok("error" in parsed)
    assert.match(parsed.error, /Invalid status/)
    assert.match(parsed.error, /ready/)
  })

  it("deduplicates repeated status values", () => {
    const params = new URLSearchParams({ status: "ready,ready" })
    const parsed = parseExportParams(params)
    assert.ok(!("error" in parsed))
    if ("error" in parsed) return
    assert.deepEqual(parsed.statuses, ["ready"])
  })
})

describe("formatIsoSeconds", () => {
  it("truncates microseconds and emits Z", () => {
    assert.equal(
      formatIsoSeconds("2026-07-29T14:03:21.123456+00:00"),
      "2026-07-29T14:03:21Z",
    )
  })

  it("returns null for null input", () => {
    assert.equal(formatIsoSeconds(null), null)
  })
})
