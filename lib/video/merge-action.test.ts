import { strict as assert } from "node:assert"
import { describe, it } from "node:test"

import { decideMergeAction } from "./merge-action"

describe("decideMergeAction", () => {
  it("forced re-merge with an existing row discards and re-encodes", () => {
    assert.equal(
      decideMergeAction({
        videoIdLinked: false,
        hasRow: true,
        encodedAt: "2026-01-01T00:00:00Z",
        masterExists: true,
        uploadedAt: "2026-01-01T00:00:00Z",
        webExists: false,
      }),
      "discard+full",
    )
  })

  it("first merge with no row runs a full encode", () => {
    assert.equal(
      decideMergeAction({
        videoIdLinked: false,
        hasRow: false,
        encodedAt: null,
        masterExists: false,
        uploadedAt: null,
        webExists: false,
      }),
      "full",
    )
  })

  it("linked video with missing master is terminal", () => {
    assert.equal(
      decideMergeAction({
        videoIdLinked: true,
        hasRow: true,
        encodedAt: "2026-01-01T00:00:00Z",
        masterExists: false,
        uploadedAt: null,
        webExists: false,
      }),
      "missing_asset",
    )
  })

  it("uploaded web video skips without consulting web.mp4", () => {
    assert.equal(
      decideMergeAction({
        videoIdLinked: true,
        hasRow: true,
        encodedAt: "2026-01-01T00:00:00Z",
        masterExists: true,
        uploadedAt: "2026-01-01T00:00:00Z",
        webExists: false,
      }),
      "skip",
    )
  })

  it("reserved key with null uploaded_at resolves to upload, not skip", () => {
    assert.equal(
      decideMergeAction({
        videoIdLinked: true,
        hasRow: true,
        encodedAt: "2026-01-01T00:00:00Z",
        masterExists: true,
        uploadedAt: null,
        webExists: true,
      }),
      "upload",
    )
  })

  it("master without web re-encodes web and uploads", () => {
    assert.equal(
      decideMergeAction({
        videoIdLinked: true,
        hasRow: true,
        encodedAt: "2026-01-01T00:00:00Z",
        masterExists: true,
        uploadedAt: null,
        webExists: false,
      }),
      "web+upload",
    )
  })

  it("linked row without encoded_at is treated as discard+full (unreachable)", () => {
    assert.equal(
      decideMergeAction({
        videoIdLinked: true,
        hasRow: true,
        encodedAt: null,
        masterExists: true,
        uploadedAt: null,
        webExists: true,
      }),
      "discard+full",
    )
  })
})
