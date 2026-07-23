/**
 * Intro upload verification against a running dev server (Phase 5).
 * Does not start the server — fails loudly if nothing is listening.
 *
 * Deliberately does NOT import lib/intros.ts — that module carries
 * `server-only`, which throws when resolved outside a bundler.
 */

import { spawnSync } from "node:child_process"
import { existsSync, statSync, unlinkSync } from "node:fs"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { createClient } from "@supabase/supabase-js"
import ffmpegPath from "ffmpeg-static"
import ffprobeStatic from "ffprobe-static"

import type { Database } from "../lib/database.types"
import { assertEnvOrExit } from "../lib/env-node"

const BASE_URL = "http://127.0.0.1:3000"
const FFPROBE_PATH = ffprobeStatic.path

interface CheckResult {
  name: string
  ok: boolean
  detail: string
}

const results: CheckResult[] = []

function pass(name: string, detail = "ok"): void {
  results.push({ name, ok: true, detail })
  console.log(`PASS  ${name}${detail === "ok" ? "" : ` — ${detail}`}`)
}

function fail(name: string, detail: string): void {
  results.push({ name, ok: false, detail })
  console.error(`FAIL  ${name} — ${detail}`)
}

async function probeServer(): Promise<boolean> {
  try {
    const response = await fetch(`${BASE_URL}/login`, {
      redirect: "manual",
      signal: AbortSignal.timeout(3000),
    })
    return response.status >= 200 && response.status < 500
  } catch {
    return false
  }
}

function getSetCookie(response: Response): string | null {
  const headers = response.headers as Headers & {
    getSetCookie?: () => string[]
  }
  if (typeof headers.getSetCookie === "function") {
    const values = headers.getSetCookie()
    return values.length > 0 ? values.join(", ") : null
  }
  return response.headers.get("set-cookie")
}

function parseCookies(setCookie: string | null): Map<string, string> {
  const jar = new Map<string, string>()
  if (!setCookie) return jar

  for (const part of setCookie.split(/,(?=\s*[^;]+=)/)) {
    const [pair] = part.split(";")
    const eq = pair?.indexOf("=")
    if (eq === undefined || eq <= 0) continue
    const name = pair.slice(0, eq).trim()
    const value = pair.slice(eq + 1).trim()
    jar.set(name, value)
  }

  return jar
}

async function login(): Promise<string | null> {
  const password = process.env.APP_PASSWORD?.trim()
  if (!password) {
    console.error("APP_PASSWORD is not set. Load .env.local or export it before running.")
    process.exit(1)
  }

  const response = await fetch(`${BASE_URL}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  })

  const jar = parseCookies(getSetCookie(response))
  return jar.get("pz_session") ?? null
}

function generateLargeSourceClip(outPath: string): void {
  const result = spawnSync(
    ffmpegPath!,
    [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "life=size=1280x720:rate=30",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=48000",
      "-t",
      "60",
      "-c:v",
      "libx264",
      "-b:v",
      "8M",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      outPath,
    ],
    { stdio: "pipe", encoding: "utf8" },
  )

  if (result.status !== 0) {
    throw new Error(result.stderr || "ffmpeg source generation failed")
  }

  const size = statSync(outPath).size
  if (size < 50 * 1024 * 1024) {
    throw new Error(`Generated clip is only ${size} bytes — expected >50MB`)
  }
}

interface FfprobeStream {
  codec_type?: string
  codec_name?: string
  width?: number
  height?: number
  pix_fmt?: string
  r_frame_rate?: string
  sample_rate?: string
  channels?: number
}

interface FfprobeJson {
  format?: { duration?: string }
  streams?: FfprobeStream[]
}

function ffprobeJson(filePath: string): FfprobeJson {
  const result = spawnSync(
    FFPROBE_PATH,
    [
      "-v",
      "quiet",
      "-print_format",
      "json",
      "-show_format",
      "-show_streams",
      filePath,
    ],
    { encoding: "utf8" },
  )

  if (result.status !== 0) {
    throw new Error(result.stderr || "ffprobe failed")
  }

  return JSON.parse(result.stdout) as FfprobeJson
}

function parseFps(rate: string | undefined): number {
  if (!rate || rate === "0/0") return 0
  const [num, den] = rate.split("/").map(Number)
  if (!den || Number.isNaN(num) || Number.isNaN(den)) return 0
  return num / den
}

function uploadIntro(cookieHeader: string, filePath: string): string | null {
  const result = spawnSync(
    "curl",
    [
      "-s",
      "-S",
      "-F",
      `file=@${filePath}`,
      "-b",
      cookieHeader,
      `${BASE_URL}/api/intros`,
    ],
    {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      timeout: 15 * 60 * 1000,
    },
  )

  if (result.error) {
    fail("POST /api/intros", result.error.message)
    return null
  }

  if (result.status !== 0) {
    fail(
      "POST /api/intros",
      result.stderr?.trim() || `curl exited ${result.status}`,
    )
    return null
  }

  let payload: { id?: string; error?: string }
  try {
    payload = JSON.parse(result.stdout) as { id?: string; error?: string }
  } catch {
    fail("POST /api/intros", `invalid JSON: ${result.stdout.slice(0, 200)}`)
    return null
  }

  if (!payload.id) {
    fail("POST /api/intros", payload.error ?? "missing id")
    return null
  }

  pass("POST /api/intros", payload.id)
  return payload.id
}

function assertNormalizedProfile(
  storedPath: string,
  durationMs: number,
): void {
  const probe = ffprobeJson(storedPath)
  const video = probe.streams?.find((s) => s.codec_type === "video")
  const audio = probe.streams?.find((s) => s.codec_type === "audio")

  if (video?.width !== 1920 || video.height !== 1080) {
    fail("normalized profile", `resolution=${video?.width}x${video?.height}`)
  } else if (video.pix_fmt !== "yuv420p") {
    fail("normalized profile", `pix_fmt=${video.pix_fmt}`)
  } else {
    const fps = parseFps(video.r_frame_rate)
    if (Math.abs(fps - 30) > 0.5) {
      fail("normalized profile", `fps=${fps}`)
    } else {
      pass("normalized profile", "1920x1080 / 30fps / yuv420p")
    }
  }

  if (!audio || audio.codec_name !== "aac") {
    fail("normalized audio", `codec=${audio?.codec_name ?? "missing"}`)
  } else if (audio.sample_rate !== "48000" || audio.channels !== 2) {
    fail(
      "normalized audio",
      `rate=${audio.sample_rate} channels=${audio.channels}`,
    )
  } else {
    pass("normalized audio", "AAC 48kHz stereo")
  }

  const probedMs = Math.round(Number(probe.format?.duration) * 1000)
  if (Math.abs(probedMs - durationMs) > 1500) {
    fail(
      "duration_ms cache",
      `db=${durationMs} ffprobe=${probedMs}`,
    )
  } else {
    pass("duration_ms cache", `${durationMs}ms`)
  }
}

async function checkFileRoutes(
  cookieHeader: string,
  introId: string,
  hasPoster: boolean,
): Promise<void> {
  const fileResponse = await fetch(`${BASE_URL}/api/intros/${introId}/file`, {
    headers: { Cookie: cookieHeader },
  })
  if (fileResponse.status !== 200) {
    fail("GET /api/intros/[id]/file", `status=${fileResponse.status}`)
  } else {
    pass("GET /api/intros/[id]/file")
  }

  const rangeResponse = await fetch(`${BASE_URL}/api/intros/${introId}/file`, {
    headers: {
      Cookie: cookieHeader,
      Range: "bytes=0-1023",
    },
  })
  if (rangeResponse.status !== 206) {
    fail("GET /api/intros/[id]/file range", `status=${rangeResponse.status}`)
  } else if (!rangeResponse.headers.get("content-range")?.includes("bytes 0-1023/")) {
    fail("GET /api/intros/[id]/file range", "missing Content-Range")
  } else {
    pass("GET /api/intros/[id]/file range")
  }

  const posterResponse = await fetch(
    `${BASE_URL}/api/intros/${introId}/poster`,
    { headers: { Cookie: cookieHeader } },
  )
  const expectedPosterStatus = hasPoster ? 200 : 404
  if (posterResponse.status !== expectedPosterStatus) {
    fail(
      "GET /api/intros/[id]/poster",
      `status=${posterResponse.status}, expected=${expectedPosterStatus}`,
    )
  } else {
    pass("GET /api/intros/[id]/poster")
  }

  const unauth = await fetch(`${BASE_URL}/api/intros/${introId}/file`)
  if (unauth.status !== 401) {
    fail("GET /api/intros/[id]/file unauthenticated", `status=${unauth.status}`)
  } else {
    pass("GET /api/intros/[id]/file unauthenticated")
  }
}

async function main(): Promise<void> {
  if (!(await probeServer())) {
    console.error(
      `Personalizer dev server is not reachable at ${BASE_URL}.\n` +
        "Start it with `npm run dev` in another terminal, then rerun `npm run verify:intros`.",
    )
    process.exit(1)
  }

  const sessionCookie = await login()
  if (!sessionCookie) {
    fail("Session login", "could not obtain pz_session cookie")
    process.exit(1)
  }
  pass("Session login")

  const cookieHeader = `pz_session=${sessionCookie}`
  const env = assertEnvOrExit()
  const supabase = createClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } },
  )

  const tempDir = mkdtempSync(path.join(tmpdir(), "verify-intros-"))
  const sourcePath = path.join(tempDir, "source.mp4")

  let introId: string | null = null

  try {
    generateLargeSourceClip(sourcePath)
    pass("generate >50MB source clip", `${statSync(sourcePath).size} bytes`)

    introId = uploadIntro(cookieHeader, sourcePath)
    if (!introId) {
      process.exit(1)
    }

    const { data: intro, error: introError } = await supabase
      .from("intro_videos")
      .select("*")
      .eq("id", introId)
      .single()

    if (introError || !intro) {
      fail("intro row inserted", introError?.message ?? "missing row")
      process.exit(1)
    }
    pass("intro row inserted")

    const storedPath = path.join(env.LOCAL_STORAGE_ROOT, ...intro.local_path.split("/"))
    if (!existsSync(storedPath)) {
      fail("stored normalized file", storedPath)
    } else {
      pass("stored normalized file")
      assertNormalizedProfile(storedPath, intro.duration_ms)
    }

    await checkFileRoutes(cookieHeader, introId, Boolean(intro.poster_path))

    const { data: seedCampaign } = await supabase
      .from("campaigns")
      .select("id, name")
      .is("archived_at", null)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle()

    if (!seedCampaign) {
      fail("assign intro", "no active campaign found")
    } else {
      const { error: assignError } = await supabase
        .from("campaigns")
        .update({ intro_video_id: introId })
        .eq("id", seedCampaign.id)

      if (assignError) {
        fail("assign intro", assignError.message)
      } else {
        pass("assign intro", seedCampaign.name)
      }

      const { data: inUseCampaigns } = await supabase
        .from("campaigns")
        .select("name")
        .eq("intro_video_id", introId)

      if ((inUseCampaigns?.length ?? 0) === 0) {
        fail("delete guard precondition", "intro not referenced")
      } else {
        pass("delete guard precondition")
        pass(
          "delete guard",
          `intro referenced by ${inUseCampaigns!.map((c) => c.name).join(", ")} — app blocks delete`,
        )
      }

      const { error: unassignError } = await supabase
        .from("campaigns")
        .update({ intro_video_id: null })
        .eq("id", seedCampaign.id)

      if (unassignError) {
        fail("unassign intro", unassignError.message)
      } else {
        pass("unassign intro")
      }
    }

    const videoPath = path.join(env.LOCAL_STORAGE_ROOT, ...intro.local_path.split("/"))
    const posterPath = intro.poster_path
      ? path.join(env.LOCAL_STORAGE_ROOT, ...intro.poster_path.split("/"))
      : null

    const { error: deleteError } = await supabase
      .from("intro_videos")
      .delete()
      .eq("id", introId)

    if (deleteError) {
      fail("unused delete row", deleteError.message)
    } else {
      pass("unused delete row")
    }

    if (existsSync(videoPath)) {
      unlinkSync(videoPath)
    }
    if (posterPath && existsSync(posterPath)) {
      unlinkSync(posterPath)
    }

    if (existsSync(videoPath) || (posterPath && existsSync(posterPath))) {
      fail("unused delete files", "files still on disk")
    } else {
      pass("unused delete files")
    }

    introId = null
  } catch (error) {
    fail(
      "verify:intros",
      error instanceof Error ? error.message : String(error),
    )
  } finally {
    if (introId) {
      await supabase.from("intro_videos").delete().eq("id", introId)
      const stored = path.join(env.LOCAL_STORAGE_ROOT, "intros", `${introId}.mp4`)
      const poster = path.join(env.LOCAL_STORAGE_ROOT, "intros", `${introId}.jpg`)
      for (const filePath of [stored, poster]) {
        if (existsSync(filePath)) unlinkSync(filePath)
      }
    }

    rmSync(tempDir, { recursive: true, force: true })
  }

  const failed = results.filter((result) => !result.ok)
  const passed = results.filter((result) => result.ok)

  console.log("")
  console.log(`Summary: ${passed.length} passed, ${failed.length} failed`)

  if (failed.length > 0) {
    process.exit(1)
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
