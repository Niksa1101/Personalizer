/**
 * Phase 8 recorder verification — fixture leg (hermetic) + optional real-site leg.
 *
 * Fixture leg runs in CI. Real-site leg requires RECORD_REAL=1 and network access.
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { classifyFailure } from "../lib/pipeline-retry"
import { evaluateRecordingPrecheck } from "../lib/recording-precheck"
import { assertEnvOrExit } from "../lib/env-node"
import { MIN_SCROLL_DURATION_MS, MAX_SCROLL_DURATION_MS } from "../worker/recorder/scroll"
import { classifyCaptureError } from "../worker/recorder/classify"
import {
  CaptureFailedError,
  captureRecording,
} from "../worker/recorder"
import { closeSharedBrowser } from "../worker/recorder/browser"

import { startFixtureServer } from "./fixtures/record/fixture-server"

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

async function withTempStorageRoot<T>(fn: () => Promise<T>): Promise<T> {
  const previous = process.env.LOCAL_STORAGE_ROOT
  const tempRoot = mkdtempSync(path.join(tmpdir(), "pz-record-verify-"))
  process.env.LOCAL_STORAGE_ROOT = tempRoot

  try {
    return await fn()
  } finally {
    if (previous === undefined) {
      delete process.env.LOCAL_STORAGE_ROOT
    } else {
      process.env.LOCAL_STORAGE_ROOT = previous
    }
    rmSync(tempRoot, { recursive: true, force: true })
  }
}

async function runFixtureLeg(): Promise<void> {
  if (classifyCaptureError({
    url: "http://127.0.0.1/parked",
    page: {
      innerTextLength: 500,
      scrollHeight: 1080,
      viewportHeight: 1080,
      finalUrl: "http://127.0.0.1/parked",
      bodyHtml: "<html><body>This domain is for sale</body></html>",
    },
  }) === "parked_domain") {
    pass("classify parked fixture")
  } else {
    fail("classify parked fixture", "expected parked_domain")
  }

  if (classifyCaptureError({
    url: "http://127.0.0.1/empty",
    page: {
      innerTextLength: 0,
      scrollHeight: 800,
      viewportHeight: 1080,
      finalUrl: "http://127.0.0.1/empty",
      bodyHtml: "<html><body></body></html>",
    },
  }) === "empty_page") {
    pass("classify empty fixture")
  } else {
    fail("classify empty fixture", "expected empty_page")
  }

  if (classifyCaptureError({
    url: "http://127.0.0.1/login",
    page: {
      innerTextLength: 500,
      scrollHeight: 1080,
      viewportHeight: 1080,
      finalUrl: "http://127.0.0.1/login?next=/",
      bodyHtml: "<html><body>Login</body></html>",
    },
  }) === "login_required") {
    pass("classify login fixture")
  } else {
    fail("classify login fixture", "expected login_required")
  }

  const reuseFresh = await evaluateRecordingPrecheck({
    recording: {
      id: "rec-1",
      local_path: "batch/acme/recording.mp4",
      purged_at: null,
    },
    forcedRerecord: false,
    statFile: async () => ({ exists: true }),
  })
  if (reuseFresh.action === "reuse") {
    pass("reuse precheck selects existing recording")
  } else {
    fail("reuse precheck selects existing recording", reuseFresh.action)
  }

  const secondRun = await evaluateRecordingPrecheck({
    recording: {
      id: "rec-1",
      local_path: "batch/acme/recording.mp4",
      purged_at: null,
    },
    forcedRerecord: false,
    statFile: async () => ({ exists: true }),
  })
  if (secondRun.action === "reuse") {
    pass("second run reuses without re-capture")
  } else {
    fail("second run reuses without re-capture", secondRun.action)
  }

  const dnsCode = classifyCaptureError({
    url: "https://dead.example.invalid",
    err: new Error("getaddrinfo ENOTFOUND dead.example.invalid"),
  })
  if (dnsCode === "dns_failure" && classifyFailure(dnsCode) === "terminal") {
    pass("dead domain maps to dns_failure with no retry")
  } else {
    fail("dead domain maps to dns_failure with no retry", dnsCode)
  }

  const timeoutCode = classifyCaptureError({
    url: "http://127.0.0.1/slow",
    err: new Error("Navigation timeout of 1000 ms exceeded"),
  })
  if (timeoutCode === "nav_timeout" && classifyFailure(timeoutCode) === "retryable") {
    pass("slow route maps to nav_timeout with retries")
  } else {
    fail("slow route maps to nav_timeout with retries", timeoutCode)
  }

  const server = await startFixtureServer()

  try {
    await withTempStorageRoot(async () => {
      const captured = await captureRecording({
        url: `${server.baseUrl}/tall`,
        batchId: "fixture-batch",
        leadSlugValue: "tall-fixture",
        viewportWidth: 1280,
        viewportHeight: 720,
        navTimeoutMs: 30_000,
        scrollEaseMs: 800,
        postLoadDelayMs: 300,
        signal: AbortSignal.timeout(120_000),
      })

      if (
        captured.durationMs >= MIN_SCROLL_DURATION_MS &&
        captured.durationMs <= MAX_SCROLL_DURATION_MS
      ) {
        pass(
          "tall fixture produces mp4 in duration range",
          `${captured.durationMs}ms`,
        )
      } else {
        fail(
          "tall fixture produces mp4 in duration range",
          `${captured.durationMs}ms`,
        )
      }

      try {
        await captureRecording({
          url: `${server.baseUrl}/parked`,
          batchId: "fixture-batch",
          leadSlugValue: "parked-fixture",
          viewportWidth: 1280,
          viewportHeight: 720,
          navTimeoutMs: 10_000,
          scrollEaseMs: 800,
          postLoadDelayMs: 100,
          signal: AbortSignal.timeout(30_000),
        })
        fail("parked fixture fails capture", "expected CaptureFailedError")
      } catch (error) {
        if (error instanceof CaptureFailedError && error.code === "parked_domain") {
          pass("parked fixture fails with parked_domain")
        } else {
          fail(
            "parked fixture fails with parked_domain",
            error instanceof Error ? error.message : String(error),
          )
        }
      }

      try {
        await captureRecording({
          url: `${server.baseUrl}/slow`,
          batchId: "fixture-batch",
          leadSlugValue: "slow-fixture",
          viewportWidth: 1280,
          viewportHeight: 720,
          navTimeoutMs: 1_500,
          scrollEaseMs: 800,
          postLoadDelayMs: 100,
          signal: AbortSignal.timeout(30_000),
        })
        fail("slow fixture times out", "expected CaptureFailedError")
      } catch (error) {
        if (error instanceof CaptureFailedError && error.code === "nav_timeout") {
          pass("slow fixture times out with nav_timeout")
        } else {
          fail(
            "slow fixture times out with nav_timeout",
            error instanceof Error ? error.message : String(error),
          )
        }
      }
    })
  } finally {
    await server.close()
  }
}

const REAL_SITES = [
  "https://example.com",
  "https://www.wikipedia.org",
  "https://www.mozilla.org",
  "https://www.python.org",
  "https://www.gnu.org",
  "https://www.debian.org",
  "https://www.cloudflare.com",
  "https://www.nytimes.com",
  "https://www.bbc.com",
  "https://www.reddit.com",
] as const

async function runRealSiteLeg(): Promise<void> {
  console.log("\nReal-site leg (manual gate) — pinned list:")
  for (const site of REAL_SITES) {
    console.log(`  - ${site}`)
  }

  await withTempStorageRoot(async () => {
    for (const site of REAL_SITES) {
      try {
        const captured = await captureRecording({
          url: site,
          batchId: "real-verify",
          leadSlugValue: `real-${new URL(site).hostname.replace(/\./g, "-")}`,
          viewportWidth: 1920,
          viewportHeight: 1080,
          navTimeoutMs: 120_000,
          scrollEaseMs: 800,
          postLoadDelayMs: 1500,
          signal: AbortSignal.timeout(180_000),
        })

        if (
          captured.durationMs >= MIN_SCROLL_DURATION_MS &&
          captured.durationMs <= MAX_SCROLL_DURATION_MS
        ) {
          pass(`real site ${site}`, `${captured.durationMs}ms`)
        } else {
          fail(`real site ${site}`, `${captured.durationMs}ms out of range`)
        }
      } catch (error) {
        fail(
          `real site ${site}`,
          error instanceof Error ? error.message : String(error),
        )
      }
    }
  })
}

async function main(): Promise<void> {
  assertEnvOrExit()

  console.log("verify:record — fixture leg\n")
  await runFixtureLeg()

  if (process.env.RECORD_REAL === "1") {
    console.log("\nverify:record — real-site leg\n")
    await runRealSiteLeg()
  } else {
    console.log("\nSkipping real-site leg (set RECORD_REAL=1 to enable).")
  }

  await closeSharedBrowser()

  const failed = results.filter((result) => !result.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)

  if (failed.length > 0) {
    process.exit(1)
  }
}

main().catch(async (error) => {
  console.error("verify:record fatal:", error)
  await closeSharedBrowser().catch(() => undefined)
  process.exit(1)
})
