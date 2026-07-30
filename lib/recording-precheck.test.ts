import { strict as assert } from "node:assert"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "node:os"
import { describe, it } from "node:test"

import { resetEnvCache } from "./env"
import { evaluateRecordingPrecheck } from "./recording-precheck"

const row = {
  id: "rec-1",
  local_path: "batch/acme/recording.mp4",
  purged_at: null,
}

describe("evaluateRecordingPrecheck", () => {
  it("returns record_fresh when no recording exists", async () => {
    const result = await evaluateRecordingPrecheck({
      recording: null,
      forcedRerecord: false,
    })
    assert.deepEqual(result, { action: "record_fresh" })
  })

  it("returns reuse when a usable file exists on disk", async () => {
    const result = await evaluateRecordingPrecheck({
      recording: row,
      forcedRerecord: false,
      statFile: async () => ({ exists: true }),
    })
    assert.deepEqual(result, {
      action: "reuse",
      recordingId: "rec-1",
      path: "batch/acme/recording.mp4",
    })
  })

  it("returns record_purged when local_path is null and purged_at is set", async () => {
    const result = await evaluateRecordingPrecheck({
      recording: {
        id: "rec-1",
        local_path: null,
        purged_at: "2026-01-01T00:00:00Z",
      },
      forcedRerecord: false,
    })
    assert.deepEqual(result, {
      action: "record_purged",
      recordingId: "rec-1",
    })
  })

  it("returns missing_asset when local_path is null without purged_at", async () => {
    const result = await evaluateRecordingPrecheck({
      recording: {
        id: "rec-1",
        local_path: null,
        purged_at: null,
      },
      forcedRerecord: false,
    })
    assert.deepEqual(result, { action: "missing_asset" })
  })

  it("returns missing_asset when the file is gone without purged_at", async () => {
    const result = await evaluateRecordingPrecheck({
      recording: row,
      forcedRerecord: false,
      statFile: async () => ({ exists: false }),
    })
    assert.deepEqual(result, { action: "missing_asset" })
  })

  it("returns record_purged when the file is gone but purged_at is set", async () => {
    const result = await evaluateRecordingPrecheck({
      recording: {
        ...row,
        purged_at: "2026-01-01T00:00:00Z",
      },
      forcedRerecord: false,
      statFile: async () => ({ exists: false }),
    })
    assert.deepEqual(result, {
      action: "record_purged",
      recordingId: "rec-1",
    })
  })

  it("returns record_purged when purged_at is set even if the file still exists", async () => {
    const result = await evaluateRecordingPrecheck({
      recording: {
        ...row,
        purged_at: "2026-01-01T00:00:00Z",
      },
      forcedRerecord: false,
      statFile: async () => ({ exists: true }),
    })
    assert.deepEqual(result, {
      action: "record_purged",
      recordingId: "rec-1",
    })
  })

  it("returns record_fresh on forced re-record even when a usable file exists", async () => {
    const result = await evaluateRecordingPrecheck({
      recording: row,
      forcedRerecord: true,
      statFile: async () => ({ exists: true }),
    })
    assert.deepEqual(result, { action: "record_fresh" })
  })

  it("default statFile resolves relative local_path via LOCAL_STORAGE_ROOT", async () => {
    const storageRoot = path.join(tmpdir(), `precheck-${Date.now()}`)
    const relPath = "batch/acme/recording.mp4"
    const absPath = path.join(storageRoot, ...relPath.split("/"))
    const savedEnv = { ...process.env }

    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://abcdefgh.supabase.co"
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key"
    process.env.NETLIFY_SITE_ID = "site-id"
    process.env.NETLIFY_TOKEN = "netlify-token"
    process.env.LOCAL_STORAGE_ROOT = storageRoot
    process.env.REDIS_URL = "redis://127.0.0.1:6379"
    process.env.APP_PASSWORD = "a-real-password"
    process.env.SESSION_SECRET = "s".repeat(32)
    resetEnvCache()
    await mkdir(path.dirname(absPath), { recursive: true })
    await writeFile(absPath, "mp4")

    try {
      const result = await evaluateRecordingPrecheck({
        recording: { ...row, local_path: relPath },
        forcedRerecord: false,
      })
      assert.deepEqual(result, {
        action: "reuse",
        recordingId: "rec-1",
        path: relPath,
      })
    } finally {
      process.env = savedEnv
      resetEnvCache()
    }
  })
})
