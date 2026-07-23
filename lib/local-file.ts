import "server-only"

import { createReadStream } from "node:fs"
import { copyFile, mkdir, readdir, rename, stat, unlink } from "node:fs/promises"
import path from "node:path"

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

/** Delete a file if it exists; ignore ENOENT. */
export async function removeIfExists(filePath: string): Promise<void> {
  try {
    await unlink(filePath)
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
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
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
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
          // Another worker's sweep (or an upload's cleanup) removed it between
          // readdir and stat — nothing to do, and this must not fail boot.
          if (
            error instanceof Error &&
            "code" in error &&
            (error as NodeJS.ErrnoException).code === "ENOENT"
          ) {
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
