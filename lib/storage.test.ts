import { strict as assert } from "node:assert"
import { describe, it } from "node:test"

import {
  finalRelPath,
  mergeTempMasterRelPath,
  posterRelPath,
  resolveMergeOutputDir,
  webRelPath,
} from "./storage"

describe("merge storage paths", () => {
  it("resolves output dir from video master_path on re-entry", () => {
    assert.equal(
      resolveMergeOutputDir({
        recordingLocalPath: null,
        videoMasterPath: "batch-a/acme-plumbing/final.mp4",
      }),
      "batch-a/acme-plumbing",
    )
  })

  it("resolves output dir from recording local_path on first merge", () => {
    assert.equal(
      resolveMergeOutputDir({
        recordingLocalPath: "batch-a/acme-plumbing/recording.mp4",
        videoMasterPath: null,
      }),
      "batch-a/acme-plumbing",
    )
  })

  it("prefers video master_path over recording when both exist", () => {
    assert.equal(
      resolveMergeOutputDir({
        recordingLocalPath: "old-batch/acme/recording.mp4",
        videoMasterPath: "stable-batch/acme/final.mp4",
      }),
      "stable-batch/acme",
    )
  })

  it("builds artifact and temp paths under the output dir", () => {
    const dir = "batch-a/acme-plumbing"
    assert.equal(finalRelPath(dir), "batch-a/acme-plumbing/final.mp4")
    assert.equal(webRelPath(dir), "batch-a/acme-plumbing/web.mp4")
    assert.equal(posterRelPath(dir), "batch-a/acme-plumbing/poster.jpg")
    assert.equal(
      mergeTempMasterRelPath(dir, "run-1"),
      "batch-a/acme-plumbing/final.run-1.tmp.mp4",
    )
  })
})
