import { randomUUID } from "node:crypto"
import { createWriteStream } from "node:fs"
import { mkdir, stat } from "node:fs/promises"
import path from "node:path"
import { Readable } from "node:stream"
import type { ReadableStream as NodeReadableStream } from "node:stream/web"
import { pipeline } from "node:stream/promises"

import { checkOrigin, unauthorizedResponse, verifySession } from "@/lib/dal"
import { INTRO_MAX_UPLOAD_BYTES, nameFromFilename } from "@/lib/intro-types"
import { insertIntro, writeWebLog } from "@/lib/intros"
import { removeIfExists } from "@/lib/local-file"
import {
  introPosterRelPath,
  introRelPath,
  introUploadTempRelPath,
  storageAbs,
} from "@/lib/storage"
import { extractPoster, normalizeIntro, probe } from "@/lib/video"

export const runtime = "nodejs"

const INTRO_TOO_LARGE_MESSAGE =
  "This video is over 500 MB — trim or re-export it smaller."

async function cleanupPaths(paths: string[]): Promise<void> {
  await Promise.all(paths.map((p) => removeIfExists(p)))
}

export async function POST(request: Request) {
  const originError = checkOrigin(request)
  if (originError) return originError

  try {
    await verifySession()
  } catch {
    return unauthorizedResponse()
  }

  const contentLength = request.headers.get("content-length")
  if (contentLength) {
    const bytes = Number.parseInt(contentLength, 10)
    if (!Number.isNaN(bytes) && bytes > INTRO_MAX_UPLOAD_BYTES) {
      return Response.json({ error: INTRO_TOO_LARGE_MESSAGE }, { status: 413 })
    }
  }

  const id = randomUUID()
  const tempPath = storageAbs(introUploadTempRelPath(id))
  const outputPath = storageAbs(introRelPath(id))
  const posterPath = storageAbs(introPosterRelPath(id))
  let originalFilename: string | null = null

  try {
    const formData = await request.formData()
    const file = formData.get("file")

    if (!(file instanceof File)) {
      return Response.json({ error: "Choose a video file to upload." }, { status: 400 })
    }

    if (file.size > INTRO_MAX_UPLOAD_BYTES) {
      return Response.json({ error: INTRO_TOO_LARGE_MESSAGE }, { status: 413 })
    }

    originalFilename = file.name
    await mkdir(path.dirname(tempPath), { recursive: true })
    await mkdir(path.dirname(outputPath), { recursive: true })

    await pipeline(
      Readable.fromWeb(file.stream() as NodeReadableStream),
      createWriteStream(tempPath),
    )

    const inputProbe = await probe(tempPath)

    // Holds the HTTP request open for the full transcode; concurrent large uploads
    // serialize behind withTranscodeLock — deliberate (no BullMQ queue for intros).
    await normalizeIntro(tempPath, outputPath, {
      hasAudio: inputProbe.hasAudio,
    })

    let posterRel: string | null = introPosterRelPath(id)
    // posterAtSec comes from the input probe; extractPoster seeks the normalized
    // output — valid only because normalization preserves duration.
    const posterAtSec = inputProbe.durationMs < 1000 ? 0 : 1
    try {
      await extractPoster(outputPath, posterPath, posterAtSec)
    } catch {
      posterRel = null
      await removeIfExists(posterPath)
    }

    const outputProbe = await probe(outputPath)
    const outputStat = await stat(outputPath)

    await insertIntro({
      id,
      name: nameFromFilename(file.name),
      local_path: introRelPath(id),
      original_filename: originalFilename,
      duration_ms: outputProbe.durationMs,
      width: outputProbe.width,
      height: outputProbe.height,
      fps: outputProbe.fps,
      file_size_bytes: outputStat.size,
      poster_path: posterRel,
    })

    await removeIfExists(tempPath)

    return Response.json({ id })
  } catch (error) {
    await cleanupPaths([tempPath, outputPath, posterPath])

    const message =
      error instanceof Error
        ? error.message
        : "Intro upload failed. Try again with a different file."

    await writeWebLog("Intro upload failed", {
      introId: id,
      originalFilename,
      error: message,
    })

    return Response.json({ error: message }, { status: 500 })
  }
}
