import { describe, it } from "node:test"
import assert from "node:assert/strict"

import { buildRetryPatch, canRetry, RETRYABLE_STATUSES, canPromote, PROMOTE_SKIP_COPY, PROMOTE_SKIP_REASONS } from "@/lib/lead-actions"
import { PIPELINE_STEPS } from "@/lib/pipeline-types"
import type { LeadStatus } from "@/lib/campaign-types"

const ALL_STATUSES: LeadStatus[] = [
  "queued",
  "processing",
  "paused",
  "deployed",
  "ready",
  "failed",
  "skipped",
]

describe("buildRetryPatch", () => {
  it("step deploy returns one object with all four deploy-reset keys", () => {
    const patch = buildRetryPatch("step", "deploy")
    assert.equal(typeof patch, "object")
    assert.ok("netlify_url" in patch)
    assert.ok("deployed_at" in patch)
    assert.ok("deployed_dry_run" in patch)
    assert.ok("current_step" in patch)
    assert.equal(patch.netlify_url, null)
    assert.equal(patch.deployed_at, null)
    assert.equal(patch.deployed_dry_run, false)
    assert.equal(patch.current_step, "deploy")
  })
})

describe("canRetry", () => {
  it("matches RETRYABLE_STATUSES for resume mode", () => {
    for (const status of ALL_STATUSES) {
      const expected = RETRYABLE_STATUSES.includes(status)
      assert.equal(canRetry(status, "resume"), expected, status)
    }
  })

  it("admits ready only for step deploy", () => {
    assert.equal(canRetry("ready", "step", "deploy"), true)
    for (const step of PIPELINE_STEPS) {
      if (step === "deploy") continue
      assert.equal(canRetry("ready", "step", step), false)
    }
  })

  it("admits skipped only for step recording", () => {
    assert.equal(canRetry("skipped", "step", "recording"), true)
    assert.equal(canRetry("skipped", "step", "merge"), false)
    assert.equal(canRetry("skipped", "resume"), false)
  })
})

describe("canPromote", () => {
  it("requires deployed status with live URL and non-removed page", () => {
    assert.deepEqual(
      canPromote({
        status: "deployed",
        netlifyUrl: "https://example.com/x",
        pageDeployStatus: "live",
      }),
      { ok: true },
    )
  })

  it("treats null pageDeployStatus as eligible (no page row)", () => {
    assert.deepEqual(
      canPromote({
        status: "deployed",
        netlifyUrl: "https://example.com/x",
        pageDeployStatus: null,
      }),
      { ok: true },
    )
  })

  it("rejects removed page before other checks after status/url", () => {
    assert.equal(
      canPromote({
        status: "deployed",
        netlifyUrl: "https://example.com/x",
        pageDeployStatus: "removed",
      }).ok,
      false,
    )
  })

  it("PROMOTE_SKIP_COPY covers every skip reason", () => {
    for (const reason of PROMOTE_SKIP_REASONS) {
      assert.ok(PROMOTE_SKIP_COPY[reason], reason)
    }
    assert.equal(Object.keys(PROMOTE_SKIP_COPY).length, PROMOTE_SKIP_REASONS.length)
  })
})
