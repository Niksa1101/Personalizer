/**
 * Phase 10 landing page verification — hermetic Chromium leg (D53).
 * Two local origins: page (A) and an asset stand-in for Supabase (B).
 */

import { createHash } from "node:crypto"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import ffmpegPath from "ffmpeg-static"
import { chromium, type Browser } from "playwright"

import { renderLandingHtml } from "../lib/landing-page"
import { DEFAULT_LANDING_TEMPLATE, SAMPLE_LEAD, sampleValuesFor } from "../lib/landing-template"
import { runProcess } from "../lib/video/spawn"

interface CheckResult {
  name: string
  ok: boolean
  detail: string
}

const FFMPEG = ffmpegPath!
const ASSET_KEY_PREFIX = "verify-page-uuid"
const VIEWPORTS = [
  { label: "375px", width: 375, height: 812 },
  { label: "1920px", width: 1920, height: 1080 },
] as const

const results: CheckResult[] = []

function pass(name: string, detail = "ok"): void {
  results.push({ name, ok: true, detail })
  console.log(`PASS  ${name}${detail === "ok" ? "" : ` — ${detail}`}`)
}

function fail(name: string, detail: string): void {
  results.push({ name, ok: false, detail })
  console.error(`FAIL  ${name} — ${detail}`)
}

function originOf(url: string): string {
  return new URL(url).origin
}

type FixtureAssets = {
  videoBytes: Buffer
  posterBytes: Buffer
  videoUrl: string
  posterUrl: string
}

type TestServers = {
  pageOrigin: string
  assetOrigin: string
  html: string
  close: () => Promise<void>
}

async function generateFixtureAssets(tempDir: string, assetOrigin: string): Promise<FixtureAssets> {
  const videoPath = path.join(tempDir, "final.mp4")
  const posterPath = path.join(tempDir, "poster.jpg")

  await runProcess(FFMPEG, [
    "-y",
    "-f",
    "lavfi",
    "-i",
    "color=c=blue:s=320x240:r=30",
    "-t",
    "1",
    "-an",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    videoPath,
  ])

  await runProcess(FFMPEG, [
    "-y",
    "-i",
    videoPath,
    "-frames:v",
    "1",
    "-q:v",
    "4",
    posterPath,
  ])

  const videoUrl = `${assetOrigin}/${ASSET_KEY_PREFIX}/final.mp4`
  const posterUrl = `${assetOrigin}/${ASSET_KEY_PREFIX}/poster.jpg`

  return {
    videoBytes: readFileSync(videoPath),
    posterBytes: readFileSync(posterPath),
    videoUrl,
    posterUrl,
  }
}

function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") {
        reject(new Error("Failed to reserve port"))
        return
      }
      const port = address.port
      server.close((error) => {
        if (error) reject(error)
        else resolve(port)
      })
    })
  })
}

function startAssetServer(
  port: number,
  assets: FixtureAssets,
): Promise<{ origin: string; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1")

      if (url.pathname === `/${ASSET_KEY_PREFIX}/final.mp4`) {
        res.writeHead(200, {
          "Content-Type": "video/mp4",
          "Cache-Control": "public, max-age=3600",
        })
        res.end(assets.videoBytes)
        return
      }

      if (url.pathname === `/${ASSET_KEY_PREFIX}/poster.jpg`) {
        res.writeHead(200, {
          "Content-Type": "image/jpeg",
          "Cache-Control": "public, max-age=3600",
        })
        res.end(assets.posterBytes)
        return
      }

      res.writeHead(404)
      res.end("not found")
    })

    server.listen(port, "127.0.0.1", () => {
      resolve({
        origin: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise((closeResolve, closeReject) => {
            server.close((error) => {
              if (error) closeReject(error)
              else closeResolve()
            })
          }),
      })
    })

    server.on("error", reject)
  })
}

function startPageServer(
  port: number,
  html: string,
): Promise<{ origin: string; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1")

      if (url.pathname === "/") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
        res.end(html)
        return
      }

      res.writeHead(404)
      res.end("not found")
    })

    server.listen(port, "127.0.0.1", () => {
      resolve({
        origin: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise((closeResolve, closeReject) => {
            server.close((error) => {
              if (error) closeReject(error)
              else closeResolve()
            })
          }),
      })
    })

    server.on("error", reject)
  })
}

async function startTestServers(tempDir: string): Promise<TestServers> {
  const [assetPort, pagePort] = await Promise.all([reservePort(), reservePort()])
  const assetOrigin = `http://127.0.0.1:${assetPort}`

  const assets = await generateFixtureAssets(tempDir, assetOrigin)
  const assetServer = await startAssetServer(assetPort, assets)

  const values = sampleValuesFor(SAMPLE_LEAD, {
    video_url: assets.videoUrl,
    poster_url: assets.posterUrl,
    cta_url: "https://example.com/book",
    cta_label: "Book a call",
  })

  const html = renderLandingHtml(DEFAULT_LANDING_TEMPLATE, values, {
    cta_type: "website",
  })

  const pageServer = await startPageServer(pagePort, html)

  return {
    pageOrigin: pageServer.origin,
    assetOrigin: assetServer.origin,
    html,
    close: async () => {
      await pageServer.close()
      await assetServer.close()
    },
  }
}

function sha1Hex(html: string): string {
  return createHash("sha1").update(html, "utf8").digest("hex")
}

function runStaticChecks(html: string, videoUrl: string, posterUrl: string): void {
  if (html.includes("{{")) {
    fail("no literal placeholders", "found {{ in rendered HTML")
  } else {
    pass("no literal placeholders")
  }

  if (!html.includes(videoUrl)) {
    fail("video_url substituted", "missing video URL in HTML")
  } else {
    pass("video_url substituted")
  }

  if (!html.includes(posterUrl)) {
    fail("poster_url substituted", "missing poster URL in HTML")
  } else {
    pass("poster_url substituted")
  }

  const first = sha1Hex(html)
  const second = sha1Hex(
    renderLandingHtml(
      DEFAULT_LANDING_TEMPLATE,
      sampleValuesFor(SAMPLE_LEAD, {
        video_url: videoUrl,
        poster_url: posterUrl,
        cta_url: "https://example.com/book",
        cta_label: "Book a call",
      }),
      { cta_type: "website" },
    ),
  )

  if (first !== second) {
    fail("sha1 stable on regeneration", `${first} !== ${second}`)
  } else {
    pass("sha1 stable on regeneration", first)
  }

  const changed = sha1Hex(
    renderLandingHtml(
      DEFAULT_LANDING_TEMPLATE,
      sampleValuesFor(SAMPLE_LEAD, {
        video_url: videoUrl,
        poster_url: posterUrl,
        cta_url: "https://example.com/other",
        cta_label: "Other CTA",
      }),
      { cta_type: "website" },
    ),
  )

  if (changed === first) {
    fail("sha1 changes when content changes", "digest unchanged")
  } else {
    pass("sha1 changes when content changes")
  }
}

async function exerciseViewport(
  browser: Browser,
  servers: TestServers,
  viewport: (typeof VIEWPORTS)[number],
  videoUrl: string,
): Promise<void> {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
  })
  const page = await context.newPage()

  const requests: string[] = []
  page.on("request", (request) => {
    requests.push(request.url())
  })

  try {
    await page.goto(`${servers.pageOrigin}/`, { waitUntil: "networkidle" })

    const bodyText = await page.locator("body").innerText()
    if (!bodyText.includes(SAMPLE_LEAD.company ?? "")) {
      fail(`${viewport.label} renders company`, "company text missing")
    } else {
      pass(`${viewport.label} renders company`)
    }

    await page.locator("video").waitFor({ state: "visible" })

    const videoRequestsBeforePlay = requests.filter((url) => url.startsWith(videoUrl))
    if (videoRequestsBeforePlay.length > 0) {
      fail(
        `${viewport.label} no video fetch before play`,
        `${videoRequestsBeforePlay.length} request(s): ${videoRequestsBeforePlay.join(", ")}`,
      )
    } else {
      pass(`${viewport.label} no video fetch before play`)
    }

    await page.locator("video").click()
    await page.locator("video").evaluate(async (video: HTMLVideoElement) => {
      await video.play()
    })

    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      if (requests.some((url) => url.startsWith(videoUrl))) {
        break
      }
      await page.waitForTimeout(200)
    }

    if (!requests.some((url) => url.startsWith(videoUrl))) {
      fail(`${viewport.label} video fetch after play`, "no video request observed")
    } else {
      pass(`${viewport.label} video fetch after play`)
    }

    const allowedOrigins = new Set([servers.pageOrigin, servers.assetOrigin])
    const unexpected = requests.filter((url) => {
      let origin: string
      try {
        origin = originOf(url)
      } catch {
        return true
      }
      return !allowedOrigins.has(origin)
    })

    if (unexpected.length > 0) {
      fail(
        `${viewport.label} third-party requests`,
        unexpected.slice(0, 5).join(", "),
      )
    } else {
      pass(`${viewport.label} third-party requests`, `${requests.length} total`)
    }

    const favicon404 = requests.some((url) => url.includes("/favicon.ico"))
    if (favicon404) {
      pass(`${viewport.label} favicon 404 tolerated`)
    }
  } finally {
    await context.close()
  }
}

async function main(): Promise<void> {
  if (!FFMPEG) {
    fail("ffmpeg-static", "binary missing")
    process.exit(1)
  }

  const tempDir = mkdtempSync(path.join(tmpdir(), "verify-page-"))
  let browser: Browser | null = null
  let servers: TestServers | null = null

  try {
    servers = await startTestServers(tempDir)

    const values = sampleValuesFor(SAMPLE_LEAD, {
      video_url: `${servers.assetOrigin}/${ASSET_KEY_PREFIX}/final.mp4`,
      poster_url: `${servers.assetOrigin}/${ASSET_KEY_PREFIX}/poster.jpg`,
      cta_url: "https://example.com/book",
      cta_label: "Book a call",
    })

    runStaticChecks(servers.html, values.video_url!, values.poster_url!)

    browser = await chromium.launch({
      headless: true,
      args: ["--disable-dev-shm-usage", "--no-sandbox"],
    })

    for (const viewport of VIEWPORTS) {
      await exerciseViewport(browser, servers, viewport, values.video_url!)
    }
  } catch (error) {
    fail(
      "verify:page",
      error instanceof Error ? error.message : String(error),
    )
  } finally {
    if (browser) {
      await browser.close().catch(() => undefined)
    }
    if (servers) {
      await servers.close().catch(() => undefined)
    }
    rmSync(tempDir, { recursive: true, force: true })
  }

  const failed = results.filter((result) => !result.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)

  if (failed.length > 0) {
    process.exit(1)
  }
}

main().catch((error) => {
  console.error("verify:page fatal:", error)
  process.exit(1)
})
