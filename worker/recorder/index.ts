import { randomUUID } from "node:crypto"
import { mkdir, readdir, stat } from "node:fs/promises"
import path from "node:path"

import ffmpegStatic from "ffmpeg-static"
import type { Page, Response } from "playwright"

import { moveFile, removeDir, removeFile } from "@/lib/local-file"
import { PipelineStepError, ShutdownError } from "@/lib/pipeline-types"
import {
  recordingRelPath,
  recordingTmpDirRelPath,
  screenshotAfterRelPath,
  screenshotBeforeRelPath,
  storageAbs,
} from "@/lib/storage"
import { probe } from "@/lib/video/probe"
import { FfmpegProcessError, runProcess } from "@/lib/video/spawn"

import { createRecordingContext } from "./browser"
import { classifyCaptureError, type PageProbe } from "./classify"
import { dismissCookieBanner } from "./cookie-banners"
import { computeScrollPlan } from "./scroll"
import scrollDriver from "./scroll-driver.js"

const FFMPEG_PATH = ffmpegStatic
const TRANSCODE_CRF = 20
const TRANSCODE_PRESET = "veryfast"

export class CaptureFailedError extends PipelineStepError {
  readonly screenshotBeforeRelPath: string | null
  readonly screenshotAfterRelPath: string | null

  constructor(
    code: CaptureFailedError["code"],
    detail: string,
    screenshots: {
      screenshotBeforeRelPath: string | null
      screenshotAfterRelPath: string | null
    },
  ) {
    super(code, detail)
    this.name = "CaptureFailedError"
    this.screenshotBeforeRelPath = screenshots.screenshotBeforeRelPath
    this.screenshotAfterRelPath = screenshots.screenshotAfterRelPath
  }
}

export type CaptureRecordingInput = {
  url: string
  batchId: string
  leadSlugValue: string
  viewportWidth: number
  viewportHeight: number
  navTimeoutMs: number
  scrollEaseMs: number
  postLoadDelayMs: number
  signal: AbortSignal
}

export type CaptureRecordingResult = {
  recordingRelPath: string
  screenshotBeforeRelPath: string | null
  screenshotAfterRelPath: string | null
  durationMs: number
  width: number
  height: number
  pageHeightPx: number
  fileSizeBytes: number
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new ShutdownError()
  }
}

function resolveWebsiteUrl(
  websiteUrl: string | null,
  domain: string | null,
): string {
  if (websiteUrl?.trim()) {
    const trimmed = websiteUrl.trim()
    if (/^https?:\/\//i.test(trimmed)) return trimmed
    return `https://${trimmed}`
  }
  if (domain?.trim()) {
    return `https://${domain.trim()}`
  }
  throw new PipelineStepError("not_a_website", "Lead has no website URL")
}

async function forceLazyImages(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.scrollTo(0, document.documentElement.scrollHeight)
  })
  await page.waitForTimeout(500)
  await page.evaluate(async () => {
    await document.fonts.ready
  })
  await page.evaluate(() => {
    window.scrollTo(0, 0)
  })
}

async function readPageProbe(page: Page): Promise<PageProbe> {
  return page.evaluate(() => ({
    innerTextLength: (document.body?.innerText ?? "").trim().length,
    scrollHeight: document.documentElement.scrollHeight,
    viewportHeight: window.innerHeight,
    finalUrl: window.location.href,
    bodyHtml: document.documentElement.outerHTML.slice(0, 250_000),
  }))
}

async function findWebmFile(tmpDirAbs: string): Promise<string | null> {
  const entries = await readdir(tmpDirAbs)
  const webm = entries.find((name) => name.endsWith(".webm"))
  return webm ? path.join(tmpDirAbs, webm) : null
}

async function transcodeWebmToMp4(
  webmAbs: string,
  mp4Abs: string,
  trim?: { startMs: number; durationMs: number },
): Promise<void> {
  if (!FFMPEG_PATH) {
    throw new PipelineStepError("ffmpeg_failure", "ffmpeg binary is missing")
  }

  const tempAbs = `${mp4Abs}.tmp.mp4`
  await removeFile(tempAbs)

  const args = ["-y", "-i", webmAbs]
  if (trim) {
    args.push(
      "-ss",
      String(trim.startMs / 1000),
      "-t",
      String(trim.durationMs / 1000),
    )
  }
  args.push(
    "-c:v",
    "libx264",
    "-crf",
    String(TRANSCODE_CRF),
    "-preset",
    TRANSCODE_PRESET,
    "-pix_fmt",
    "yuv420p",
    "-an",
    "-f",
    "mp4",
    tempAbs,
  )

  try {
    await runProcess(
      FFMPEG_PATH,
      args,
      10 * 60 * 1000,
    )
    await moveFile(tempAbs, mp4Abs)
  } catch (error) {
    await removeFile(tempAbs)
    if (error instanceof FfmpegProcessError) {
      throw new PipelineStepError(
        "ffmpeg_failure",
        `Recording transcode failed: ${error.stderr.slice(0, 2000)}`,
      )
    }
    throw error
  }
}

function classifyAndThrow(input: {
  err?: unknown
  response?: Response | null
  page?: PageProbe | null
  url: string
  screenshots: {
    screenshotBeforeRelPath: string | null
    screenshotAfterRelPath: string | null
  }
}): never {
  const code = classifyCaptureError({
    err: input.err,
    httpStatus: input.response?.status() ?? null,
    page: input.page,
    url: input.url,
  })
  const detail =
    input.err instanceof Error
      ? input.err.message
      : `Capture failed (${code})`
  throw new CaptureFailedError(code, detail, input.screenshots)
}

export async function captureRecording(
  input: CaptureRecordingInput,
): Promise<CaptureRecordingResult> {
  throwIfAborted(input.signal)

  const token = randomUUID()
  const tmpDirRel = recordingTmpDirRelPath(token)
  const tmpDirAbs = storageAbs(tmpDirRel)
  await mkdir(tmpDirAbs, { recursive: true })

  const beforeRel = screenshotBeforeRelPath(input.batchId, input.leadSlugValue)
  const afterRel = screenshotAfterRelPath(input.batchId, input.leadSlugValue)
  const beforeAbs = storageAbs(beforeRel)
  const afterAbs = storageAbs(afterRel)
  const recordingRel = recordingRelPath(input.batchId, input.leadSlugValue)
  const recordingAbs = storageAbs(recordingRel)

  await mkdir(path.dirname(beforeAbs), { recursive: true })

  let context: Awaited<ReturnType<typeof createRecordingContext>> | null = null
  let page: Page | null = null
  let response: Response | null = null
  let screenshotBeforeRelPathValue: string | null = null
  let screenshotAfterRelPathValue: string | null = null

  try {
    context = await createRecordingContext({
      tmpDirAbs,
      viewportWidth: input.viewportWidth,
      viewportHeight: input.viewportHeight,
    })

    page = await context.newPage()
    const videoStartAt = Date.now()
    const deadline = Date.now() + input.navTimeoutMs

    throwIfAborted(input.signal)

    try {
      response = await page.goto(input.url, {
        waitUntil: "networkidle",
        timeout: input.navTimeoutMs,
      })
    } catch (error) {
      const probeSnapshot = page ? await readPageProbe(page).catch(() => null) : null
      classifyAndThrow({
        err: error,
        response,
        page: probeSnapshot,
        url: input.url,
        screenshots: {
          screenshotBeforeRelPath: screenshotBeforeRelPathValue,
          screenshotAfterRelPath: screenshotAfterRelPathValue,
        },
      })
    }

    throwIfAborted(input.signal)

    if (Date.now() > deadline) {
      classifyAndThrow({
        err: new Error("Navigation deadline exceeded during load sequence"),
        response,
        page: await readPageProbe(page),
        url: input.url,
        screenshots: {
          screenshotBeforeRelPath: screenshotBeforeRelPathValue,
          screenshotAfterRelPath: screenshotAfterRelPathValue,
        },
      })
    }

    await forceLazyImages(page)

    if (Date.now() > deadline) {
      classifyAndThrow({
        err: new Error("Navigation deadline exceeded during lazy-load forcing"),
        response,
        page: await readPageProbe(page),
        url: input.url,
        screenshots: {
          screenshotBeforeRelPath: screenshotBeforeRelPathValue,
          screenshotAfterRelPath: screenshotAfterRelPathValue,
        },
      })
    }

    await dismissCookieBanner(page, deadline - Date.now())

    const remainingSettle = Math.min(
      input.postLoadDelayMs,
      Math.max(0, deadline - Date.now()),
    )
    if (remainingSettle > 0) {
      await page.waitForTimeout(remainingSettle)
    }

    if (Date.now() > deadline) {
      classifyAndThrow({
        err: new Error("Navigation deadline exceeded during settle"),
        response,
        page: await readPageProbe(page),
        url: input.url,
        screenshots: {
          screenshotBeforeRelPath: screenshotBeforeRelPathValue,
          screenshotAfterRelPath: screenshotAfterRelPathValue,
        },
      })
    }

    const pageProbe = await readPageProbe(page)
    const contentCode = classifyCaptureError({
      httpStatus: response?.status() ?? null,
      page: pageProbe,
      url: input.url,
    })
    if (contentCode !== "unknown") {
      try {
        await page.screenshot({ path: beforeAbs, fullPage: false })
        screenshotBeforeRelPathValue = beforeRel
      } catch {
        // Best-effort debug shot.
      }
      throw new CaptureFailedError(contentCode, contentCode, {
        screenshotBeforeRelPath: screenshotBeforeRelPathValue,
        screenshotAfterRelPath: screenshotAfterRelPathValue,
      })
    }

    try {
      await page.screenshot({ path: beforeAbs, fullPage: false })
      screenshotBeforeRelPathValue = beforeRel
    } catch {
      // Screenshot failure is not fatal.
    }

    const scrollPlan = computeScrollPlan(
      pageProbe.scrollHeight,
      input.viewportHeight,
      input.scrollEaseMs,
    )

    const scrollStartAt = Date.now()
    await page.evaluate(scrollDriver.runScrollDriver, {
      distancePx: scrollPlan.scrollDistancePx,
      durationMs: scrollPlan.durationMs,
      easeMs: scrollPlan.easeMs,
    })
    const trimStartMs = scrollStartAt - videoStartAt

    try {
      await page.screenshot({ path: afterAbs, fullPage: false })
      screenshotAfterRelPathValue = afterRel
    } catch {
      // Screenshot failure is not fatal.
    }

    const video = page.video()
    await page.close()
    page = null
    await context.close()
    context = null

    throwIfAborted(input.signal)

    const webmAbs =
      (video ? await video.path().catch(() => null) : null) ??
      (await findWebmFile(tmpDirAbs))

    if (!webmAbs) {
      throw new PipelineStepError(
        "browser_crash",
        "Playwright did not produce a WebM recording",
      )
    }

    await transcodeWebmToMp4(webmAbs, recordingAbs, {
      startMs: trimStartMs,
      durationMs: scrollPlan.durationMs,
    })
    const probed = await probe(recordingAbs)
    const fileStat = await stat(recordingAbs)

    return {
      recordingRelPath: recordingRel,
      screenshotBeforeRelPath: screenshotBeforeRelPathValue,
      screenshotAfterRelPath: screenshotAfterRelPathValue,
      durationMs: probed.durationMs,
      width: probed.width,
      height: probed.height,
      pageHeightPx: pageProbe.scrollHeight,
      fileSizeBytes: fileStat.size,
    }
  } catch (error) {
    if (error instanceof CaptureFailedError || error instanceof PipelineStepError) {
      throw error
    }
    if (input.signal.aborted) {
      throw new ShutdownError()
    }

    const probeSnapshot = page ? await readPageProbe(page).catch(() => null) : null
    return classifyAndThrow({
      err: error,
      response,
      page: probeSnapshot,
      url: input.url,
      screenshots: {
        screenshotBeforeRelPath: screenshotBeforeRelPathValue,
        screenshotAfterRelPath: screenshotAfterRelPathValue,
      },
    })
  } finally {
    if (page) {
      await page.close().catch(() => undefined)
    }
    if (context) {
      await context.close().catch(() => undefined)
    }
    await removeDir(tmpDirAbs).catch(() => undefined)
  }
}

export { resolveWebsiteUrl }
