/**
 * Generates docs/Errors.md from ERROR_COPY + docs/error-repro.json.
 *
 * Usage:
 *   npm run docs:errors        — write docs/Errors.md
 *   npm run docs:errors:check  — compare to committed file, exit non-zero on drift
 */

import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import {
  DRAWER_ACTION_IDS,
  ERROR_COPY,
} from "../lib/error-copy"
import { ERROR_CODES, type ErrorCode } from "../lib/pipeline-types"

const repoRoot = join(import.meta.dirname, "..")
const reproPath = join(repoRoot, "docs", "error-repro.json")
const outputPath = join(repoRoot, "docs", "Errors.md")
const drawerActionsPath = join(repoRoot, "components", "leads", "drawer-actions.tsx")

/** Tech.md §7.3 — bad_website codes skip retries entirely. */
function retryPolicy(code: ErrorCode): string {
  if (code === "intro_missing") return "n/a — pauses, does not fail"
  return ERROR_COPY[code].bucket === "bad_website"
    ? "no — terminal (§7.3)"
    : "yes — auto-retry then fail"
}

/**
 * intro_missing pairs with a pause (DB.md §2.4); not_a_website is written at import
 * against a lead row created as `skipped` (import_commit_fn.sql:212-216, 284).
 */
function landedStatus(code: ErrorCode): string {
  if (code === "intro_missing") return "paused"
  if (code === "not_a_website") return "skipped"
  return "failed"
}

type ReproMap = Record<string, string>

export function loadReproSidecar(): ReproMap {
  const raw = readFileSync(reproPath, "utf8")
  const parsed = JSON.parse(raw) as ReproMap
  validateReproSidecar(parsed)
  return parsed
}

export function validateReproSidecar(repro: ReproMap): void {
  const reproKeys = new Set(Object.keys(repro))
  const codeSet = new Set<string>(ERROR_CODES)

  for (const code of ERROR_CODES) {
    if (!reproKeys.has(code)) {
      throw new Error(`docs/error-repro.json missing key: ${code}`)
    }
  }
  for (const key of reproKeys) {
    if (!codeSet.has(key)) {
      throw new Error(`docs/error-repro.json unknown key: ${key}`)
    }
    const value = repro[key]?.trim() ?? ""
    if (!value) {
      throw new Error(`docs/error-repro.json empty value for: ${key}`)
    }
  }
}

function actionIdFor(code: ErrorCode): string {
  return ERROR_COPY[code].action.id
}

export function generateErrorsMarkdown(repro: ReproMap): string {
  const lines: string[] = [
    "<!-- generated — do not hand-edit; run `npm run docs:errors` -->",
    "",
    "# Error codes",
    "",
    "Plain-language reference for every pipeline `error_code`. Generated from `lib/error-copy.ts` and `docs/error-repro.json`.",
    "",
    "| error_code | bucket | message | retryable | landed status | UI location | repro |",
    "|---|---|---|---|---|---|---|",
  ]

  for (const code of ERROR_CODES) {
    const entry = ERROR_COPY[code]
    lines.push(
      `| \`${code}\` | ${entry.bucket} | ${entry.sentence.replace(/\|/g, "\\|")} | ${retryPolicy(code)} | ${landedStatus(code)} | \`${actionIdFor(code)}\` | ${repro[code]!.replace(/\|/g, "\\|")} |`,
    )
  }

  lines.push("")
  return lines.join("\n")
}

export function assertDrawerActionExhaustiveness(): string[] {
  const errors: string[] = []
  const drawerIds = new Set<string>(DRAWER_ACTION_IDS)

  for (const code of ERROR_CODES) {
    const id = ERROR_COPY[code].action.id
    if (!drawerIds.has(id)) {
      errors.push(`ERROR_COPY[${code}].action.id "${id}" not in DRAWER_ACTION_IDS`)
    }
  }

  const drawerSource = readFileSync(drawerActionsPath, "utf8")
  for (const id of DRAWER_ACTION_IDS) {
    const quoted = new RegExp(`["']${id}["']\\s*:`)
    const bare = new RegExp(`\\b${id}\\s*:`)
    if (!quoted.test(drawerSource) && !bare.test(drawerSource)) {
      errors.push(`DRAWER_ACTION_IDS includes "${id}" but ACTION_CONTROLS has no handler`)
    }
  }

  return errors
}

function main(): void {
  const checkOnly = process.argv.includes("--check")
  const repro = loadReproSidecar()
  const generated = generateErrorsMarkdown(repro)

  if (checkOnly) {
    let committed: string
    try {
      committed = readFileSync(outputPath, "utf8")
    } catch {
      console.error("docs/Errors.md missing — run npm run docs:errors")
      process.exitCode = 1
      return
    }
    if (committed !== generated) {
      console.error("docs/Errors.md drift — run npm run docs:errors")
      process.exitCode = 1
      return
    }
    console.log("docs/Errors.md matches generated output")
    return
  }

  writeFileSync(outputPath, generated, "utf8")
  console.log(`Wrote ${outputPath}`)
}

try {
  if (process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/gen-error-docs.ts")) {
    main()
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
