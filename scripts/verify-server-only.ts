/**
 * Negative build test: a client import of lib/supabase.ts must fail (D20, D30).
 * Self-cleaning — writes a temp module, runs next build, deletes the module.
 */

import { execSync } from "node:child_process"
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"

const ROOT = path.resolve(import.meta.dirname, "..")
const TEMP_DIR = path.join(ROOT, "app", "verify-server-only-temp")
const TEMP_PAGE = path.join(TEMP_DIR, "page.tsx")

const TEMP_SOURCE = `"use client"

import { getSupabaseAdmin } from "@/lib/supabase"

export default function VerifyClientImportPage() {
  return <div>{String(getSupabaseAdmin)}</div>
}
`

function cleanup(): void {
  if (existsSync(TEMP_DIR)) {
    rmSync(TEMP_DIR, { recursive: true, force: true })
  }
}

function main(): void {
  cleanup()

  try {
    mkdirSync(TEMP_DIR, { recursive: true })
    writeFileSync(TEMP_PAGE, TEMP_SOURCE, "utf8")

    let buildFailed = false
    let output = ""

    try {
      output = execSync("npm run build", {
        cwd: ROOT,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, FORCE_COLOR: "0" },
      })
    } catch (error: unknown) {
      buildFailed = true
      if (error && typeof error === "object" && "stdout" in error) {
        output = String((error as { stdout?: string }).stdout ?? "")
      }
      if (error && typeof error === "object" && "stderr" in error) {
        output += String((error as { stderr?: string }).stderr ?? "")
      }
    }

    if (!buildFailed) {
      console.error(
        "FAIL  Client import of lib/supabase.ts — build succeeded but should have failed",
      )
      process.exit(1)
    }

    const citesServerOnly =
      output.includes("server-only") ||
      output.includes("Server-only") ||
      output.includes("server only")

    if (citesServerOnly) {
      console.log(
        "PASS  Client import of lib/supabase.ts fails the build (server-only)",
      )
    } else {
      console.error(
        "FAIL  Build failed but output did not cite server-only:\n" +
          output.slice(0, 2000),
      )
      process.exit(1)
    }
  } finally {
    cleanup()
  }
}

main()
