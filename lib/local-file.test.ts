import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  DAILY_TEMP_PATTERN,
  MERGE_TEMP_PATTERN,
  PathEscapeError,
  deleteContainedRelPath,
} from "@/lib/local-file"

describe("temp patterns", () => {
  it("MERGE_TEMP_PATTERN is subset of DAILY_TEMP_PATTERN", () => {
    const samples = [
      "final.abc.tmp.mp4",
      "web.abc.tmp.mp4",
      "poster.abc.tmp.jpg",
      "recording.abc.tmp.mp4",
    ]
    for (const name of samples) {
      if (MERGE_TEMP_PATTERN.test(name)) {
        assert.equal(DAILY_TEMP_PATTERN.test(name), true, name)
      }
    }
    assert.equal(DAILY_TEMP_PATTERN.test("recording.run.tmp.mp4"), true)
    assert.equal(MERGE_TEMP_PATTERN.test("recording.run.tmp.mp4"), false)
  })
})

describe("deleteContainedRelPath", () => {
  it("throws PathEscapeError for escapes", async () => {
    const previous = process.env.LOCAL_STORAGE_ROOT
    process.env.LOCAL_STORAGE_ROOT = "C:\\pz-test-root"
    process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://example.supabase.co"
    process.env.SUPABASE_SERVICE_ROLE_KEY ??= "service-role-key"
    process.env.NETLIFY_SITE_ID ??= "site-id"
    process.env.NETLIFY_TOKEN ??= "token"
    process.env.REDIS_URL ??= "redis://127.0.0.1:6379"
    process.env.APP_PASSWORD ??= "password"
    process.env.SESSION_SECRET ??= "x".repeat(32)

    try {
      await assert.rejects(
        () => deleteContainedRelPath("../outside.txt"),
        PathEscapeError,
      )
    } finally {
      if (previous === undefined) delete process.env.LOCAL_STORAGE_ROOT
      else process.env.LOCAL_STORAGE_ROOT = previous
    }
  })
})
