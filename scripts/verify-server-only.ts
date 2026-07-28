/**
 * Negative build test: a client import of lib/supabase.ts must fail (D20, D30).
 * Static scan: lib/landing-page.ts stays browser-safe (D55).
 * Self-cleaning — writes a temp module, runs next build, deletes the module.
 */

import { execSync } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"

const ROOT = path.resolve(import.meta.dirname, "..")
const TEMP_DIR = path.join(ROOT, "app", "verify-server-only-temp")
const TEMP_PAGE = path.join(TEMP_DIR, "page.tsx")
const LANDING_PAGE_MODULE = path.join(ROOT, "lib", "landing-page.ts")
const LANDING_PAGE_IMPORTS = [
  path.join(ROOT, "lib", "landing-template.ts"),
]
const GENERATED_TYPES_DIR = path.join(ROOT, ".next", "types")

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
  if (existsSync(GENERATED_TYPES_DIR)) {
    rmSync(GENERATED_TYPES_DIR, { recursive: true, force: true })
  }
}

const PURE_CLIENT_MODULES = [
  path.join(ROOT, "lib", "lead-actions.ts"),
  path.join(ROOT, "lib", "website-url.ts"),
  path.join(ROOT, "lib", "error-copy.ts"),
]

const FORBIDDEN_IMPORT =
  /(?:from\s+["'](?:server-only|csv-parse(?:\/sync)?)["'])|(?:import\s+["'](?:server-only|csv-parse(?:\/sync)?)["'])|process\.env\b/

function collectTsFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out
  if (dir.includes(`${path.sep}.claude${path.sep}`)) return out

  for (const entry of readdirSync(dir)) {
    const abs = path.join(dir, entry)
    if (entry === ".claude") continue
    const stat = statSync(abs)
    if (stat.isDirectory()) {
      collectTsFiles(abs, out)
    } else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) {
      out.push(abs)
    }
  }
  return out
}

function resolveImport(fromFile: string, spec: string): string | null {
  if (spec.startsWith("@/")) {
    const rel = spec.slice(2).replace(/\.js$/, "")
    const base = path.join(ROOT, rel)
    const candidates = [`${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate
    }
    return null
  }

  if (spec.startsWith("./") || spec.startsWith("../")) {
    const base = path.resolve(path.dirname(fromFile), spec.replace(/\.js$/, ""))
    const candidates = [`${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate
    }
  }

  return null
}

function collectImportSpecifiers(source: string): string[] {
  const specs: string[] = []
  const fromRe = /from\s+["']([^"']+)["']/g
  for (const match of source.matchAll(fromRe)) {
    specs.push(match[1]!)
  }
  const sideEffectRe = /import\s+["']([^"']+)["']/g
  for (const match of source.matchAll(sideEffectRe)) {
    specs.push(match[1]!)
  }
  return specs
}

function assertPureModulesBrowserSafe(): void {
  const libFiles = collectTsFiles(path.join(ROOT, "lib"))
  const workerFiles = collectTsFiles(path.join(ROOT, "worker"))
  const allFiles = new Map(libFiles.concat(workerFiles).map((f) => [f, readFileSync(f, "utf8")]))

  for (const entry of PURE_CLIENT_MODULES) {
    const queue = [entry]
    const seen = new Set<string>()

    while (queue.length > 0) {
      const file = queue.pop()!
      if (seen.has(file)) continue
      seen.add(file)

      const source = allFiles.get(file) ?? readFileSync(file, "utf8")
      if (FORBIDDEN_IMPORT.test(source)) {
        console.error(
          `FAIL  ${path.relative(ROOT, file)} pulls server-only, csv-parse, or process.env into ${path.relative(ROOT, entry)} graph`,
        )
        process.exit(1)
      }

      for (const spec of collectImportSpecifiers(source)) {
        const resolved = resolveImport(file, spec)
        if (resolved && !seen.has(resolved)) queue.push(resolved)
      }
    }
  }

  console.log(
    "PASS  lib/lead-actions.ts, lib/website-url.ts, lib/error-copy.ts are browser-safe",
  )
}

function assertLandingPageBrowserSafe(): void {
  const files = [LANDING_PAGE_MODULE, ...LANDING_PAGE_IMPORTS]
  const nodeImport = /from\s+["']node:[^"']+["']|require\s*\(\s*["']node:[^"']+["']\s*\)/
  const serverOnlyImport =
    /from\s+["']server-only["']|import\s+["']server-only["']|require\s*\(\s*["']server-only["']\s*\)/

  for (const file of files) {
    const source = readFileSync(file, "utf8")
    const rel = path.relative(ROOT, file)

    if (nodeImport.test(source)) {
      console.error(`FAIL  ${rel} imports node:* — not browser-safe`)
      process.exit(1)
    }

    if (serverOnlyImport.test(source)) {
      console.error(`FAIL  ${rel} imports server-only — not browser-safe`)
      process.exit(1)
    }
  }

  console.log(
    "PASS  lib/landing-page.ts and direct imports are browser-safe (no node:*, no server-only)",
  )
}

function main(): void {
  assertLandingPageBrowserSafe()
  assertPureModulesBrowserSafe()
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
