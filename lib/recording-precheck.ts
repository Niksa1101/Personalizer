import type { ErrorCode } from "@/lib/pipeline-types"
import { storageAbs } from "@/lib/storage"

export type UsableRecordingRow = {
  id: string
  local_path: string | null
  purged_at: string | null
}

export type FileStat = (relPath: string) => Promise<{ exists: boolean }>

export type PrecheckInput = {
  recording: UsableRecordingRow | null
  forcedRerecord: boolean
  statFile?: FileStat
}

export type PrecheckResult =
  | { action: "reuse"; recordingId: string; path: string }
  | { action: "record_fresh" }
  | { action: "record_purged"; recordingId: string }
  | { action: "missing_asset" }

const defaultStatFile: FileStat = async (relPath) => {
  const { stat } = await import("node:fs/promises")
  try {
    await stat(storageAbs(relPath))
    return { exists: true }
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return { exists: false }
    }
    throw error
  }
}

/**
 * Shared purged-vs-missing decision (Tech.md §11).
 * Used by the record step now and merge in Phase 9.
 */
export async function evaluateRecordingPrecheck(
  input: PrecheckInput,
): Promise<PrecheckResult> {
  const statFile = input.statFile ?? defaultStatFile

  if (!input.recording) {
    return { action: "record_fresh" }
  }

  if (input.forcedRerecord) {
    return { action: "record_fresh" }
  }

  const { id, local_path, purged_at } = input.recording

  if (purged_at != null) {
    return { action: "record_purged", recordingId: id }
  }

  if (local_path == null) {
    return { action: "missing_asset" }
  }

  const { exists } = await statFile(local_path)
  if (!exists) {
    return { action: "missing_asset" }
  }

  return { action: "reuse", recordingId: id, path: local_path }
}

export const PURGED_RERECORD_NOTE =
  "raw recording had been purged; re-recorded automatically"

export function missingAssetError(): ErrorCode {
  return "missing_asset"
}
