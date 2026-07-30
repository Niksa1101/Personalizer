import "server-only"

import { createReadStream } from "node:fs"
import {
  copyFile,
  mkdir,
  readdir,
  rename,
  rm,
  stat,
  unlink,
} from "node:fs/promises"
import path from "node:path"

import { assertPathContained, storageAbs } from "@/lib/storage"

/** Move a file, creating parent dirs; copy+unlink if rename crosses devices. */
export async function moveFile(fromAbs: string, toAbs: string): Promise<void> {
  await mkdir(path.dirname(toAbs), { recursive: true })
  try {
    await rename(fromAbs, toAbs)
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "EXDEV"
    ) {
      await copyFile(fromAbs, toAbs)
      await unlink(fromAbs)
      return
    }
    throw error
  }
}

/** Delete a file; ignore ENOENT. */
export async function removeFile(filePath: string): Promise<void> {
  await removeIfExists(filePath)
}

export function isEnoent(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  )
}

export class PathEscapeError extends Error {
  constructor(readonly relPath: string) {
    super(`Refusing to delete a path outside LOCAL_STORAGE_ROOT: ${relPath}`)
  }
}

export type DeleteOutcome = {
  /** unlink succeeded */
  deleted: boolean
  /** file was already gone — safe to null the pointer (Q11a) */
  absent: boolean
  /** measured before unlink; 0 when absent */
  bytes: number
}

/** The only delete path Phase 16 uses. Resolves against LOCAL_STORAGE_ROOT and
 *  refuses escapes — a containment failure is an error, never a silent skip. */
export async function deleteContainedRelPath(
  relPath: string,
): Promise<DeleteOutcome> {
  const abs = storageAbs(relPath)
  if (!assertPathContained(abs)) throw new PathEscapeError(relPath)

  let bytes = 0
  try {
    bytes = (await stat(abs)).size
  } catch (error) {
    if (isEnoent(error)) return { deleted: false, absent: true, bytes: 0 }
    throw error
  }

  try {
    await unlink(abs)
  } catch (error) {
    if (isEnoent(error)) return { deleted: false, absent: true, bytes: 0 }
    throw error
  }

  return { deleted: true, absent: false, bytes }
}

/** Recursively remove a directory; ignore ENOENT. */
export async function removeDir(dirPath: string): Promise<void> {
  try {
    await rm(dirPath, { recursive: true, force: true })
  } catch (error) {
    if (isEnoent(error)) {
      return
    }
    throw error
  }
}

/** Delete a file if it exists; ignore ENOENT. */
export async function removeIfExists(filePath: string): Promise<void> {
  try {
    await unlink(filePath)
  } catch (error) {
    if (isEnoent(error)) {
      return
    }
    throw error
  }
}

const UPLOAD_TEMP_SUFFIX = "-upload"

/** Remove orphaned intro upload temps left by a crash mid-normalize. */
export async function sweepStaleIntroUploadTemps(
  tmpDirAbs: string,
  maxAgeMs = 60 * 60 * 1000,
): Promise<void> {
  let entries: string[]
  try {
    entries = await readdir(tmpDirAbs)
  } catch (error) {
    if (isEnoent(error)) {
      return
    }
    throw error
  }

  const cutoff = Date.now() - maxAgeMs
  await Promise.all(
    entries
      .filter((name) => name.endsWith(UPLOAD_TEMP_SUFFIX))
      .map(async (name) => {
        const filePath = path.join(tmpDirAbs, name)
        let fileStat
        try {
          fileStat = await stat(filePath)
        } catch (error) {
          if (isEnoent(error)) {
            return
          }
          throw error
        }
        if (fileStat.mtimeMs < cutoff) {
          await removeIfExists(filePath)
        }
      }),
  )
}

/** Remove orphaned import preview temps left by an abandoned wizard. */
export async function sweepStaleImportUploadTemps(
  tmpDirAbs: string,
  maxAgeMs = 24 * 60 * 60 * 1000,
): Promise<void> {
  let entries: string[]
  try {
    entries = await readdir(tmpDirAbs)
  } catch (error) {
    if (isEnoent(error)) {
      return
    }
    throw error
  }

  const cutoff = Date.now() - maxAgeMs
  await Promise.all(
    entries
      .filter((name) => name.startsWith("import-") && name.endsWith(".csv"))
      .map(async (name) => {
        const filePath = path.join(tmpDirAbs, name)
        let fileStat
        try {
          fileStat = await stat(filePath)
        } catch (error) {
          if (isEnoent(error)) {
            return
          }
          throw error
        }
        if (fileStat.mtimeMs < cutoff) {
          await removeIfExists(filePath)
        }
      }),
  )
}

const REC_TMP_PREFIX = "rec-"
const TEMP_STEMS_MERGE = ["final", "web"] as const
/** Adds the recorder's transcode temp. Superset of MERGE_TEMP_PATTERN. */
const TEMP_STEMS_ALL = [...TEMP_STEMS_MERGE, "recording"] as const

function tempPattern(stems: readonly string[]): RegExp {
  return new RegExp(
    `^(?:${stems.join("|")})\\..+\\.tmp\\.mp4$|^poster\\..+\\.tmp\\.jpg$`,
  )
}

/** Pre-merge sweep (worker/video/merge.ts:254) — behavior unchanged. */
export const MERGE_TEMP_PATTERN = tempPattern(TEMP_STEMS_MERGE)
/** Daily sweep only. Widening the pre-merge default would let a sibling job's
 *  10-minute sweep eat a live capture's transcode temp — see carried item C1. */
export const DAILY_TEMP_PATTERN = tempPattern(TEMP_STEMS_ALL)

/** Remove orphaned merge temps left by a crash mid-encode. */
export async function sweepStaleMergeTemps(
  outputDirAbs: string,
  maxAgeMs = 10 * 60 * 1000,
  pattern: RegExp = MERGE_TEMP_PATTERN,
): Promise<void> {
  let entries: string[]
  try {
    entries = await readdir(outputDirAbs)
  } catch (error) {
    if (isEnoent(error)) {
      return
    }
    throw error
  }

  const cutoff = Date.now() - maxAgeMs
  await Promise.all(
    entries
      .filter((name) => pattern.test(name))
      .map(async (name) => {
        const filePath = path.join(outputDirAbs, name)
        let fileStat
        try {
          fileStat = await stat(filePath)
        } catch (error) {
          if (isEnoent(error)) {
            return
          }
          throw error
        }
        if (fileStat.mtimeMs < cutoff) {
          await removeIfExists(filePath)
        }
      }),
  )
}

/** Remove orphaned recorder temps left by a crash mid-capture. */
export async function sweepStaleRecorderTemps(
  tmpDirAbs: string,
  maxAgeMs = 24 * 60 * 60 * 1000,
): Promise<void> {
  let entries: string[]
  try {
    entries = await readdir(tmpDirAbs)
  } catch (error) {
    if (isEnoent(error)) {
      return
    }
    throw error
  }

  const cutoff = Date.now() - maxAgeMs
  await Promise.all(
    entries
      .filter((name) => name.startsWith(REC_TMP_PREFIX))
      .map(async (name) => {
        const dirPath = path.join(tmpDirAbs, name)
        let dirStat
        try {
          dirStat = await stat(dirPath)
        } catch (error) {
          if (isEnoent(error)) {
            return
          }
          throw error
        }
        if (!dirStat.isDirectory()) {
          await removeIfExists(dirPath)
          return
        }
        if (dirStat.mtimeMs < cutoff) {
          await removeDir(dirPath)
        }
      }),
  )
}

/** Stream a local file with optional HTTP Range support (D13). */
export async function serveLocalFile(
  request: Request,
  absolutePath: string,
  contentType: string,
): Promise<Response> {
  let fileStat
  try {
    fileStat = await stat(absolutePath)
  } catch {
    return new Response(null, { status: 404 })
  }

  const size = fileStat.size
  const baseHeaders: Record<string, string> = {
    "Content-Type": contentType,
    "Accept-Ranges": "bytes",
  }

  const range = request.headers.get("range")
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range)
    if (!match) {
      return new Response(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${size}` },
      })
    }

    const start = match[1] ? Number.parseInt(match[1], 10) : 0
    const end = match[2] ? Number.parseInt(match[2], 10) : size - 1

    if (
      Number.isNaN(start) ||
      Number.isNaN(end) ||
      start >= size ||
      end >= size ||
      start > end
    ) {
      return new Response(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${size}` },
      })
    }

    const chunkSize = end - start + 1
    const stream = createReadStream(absolutePath, { start, end })

    return new Response(stream as unknown as BodyInit, {
      status: 206,
      headers: {
        ...baseHeaders,
        "Content-Length": String(chunkSize),
        "Content-Range": `bytes ${start}-${end}/${size}`,
      },
    })
  }

  const stream = createReadStream(absolutePath)
  return new Response(stream as unknown as BodyInit, {
    status: 200,
    headers: {
      ...baseHeaders,
      "Content-Length": String(size),
    },
  })
}
