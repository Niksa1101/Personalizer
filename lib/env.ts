/**
 * Startup environment validation.
 *
 * Spec: `docs/Tech.md` §14.1 — all eight variables are validated at startup in
 * both the Next.js process and the worker process, and a missing variable
 * refuses the boot while naming *every* missing variable at once. A
 * half-configured system that starts and then fails on lead 40 wastes far more
 * time than one that refuses to start.
 *
 * This module is imported by both processes, so it must NOT import
 * `server-only` — that guard is for modules that must never reach a client
 * bundle (`lib/supabase.ts`, `lib/dal.ts`), and it throws when resolved outside
 * a bundler. Nothing here is secret: it reads names and reports which are
 * absent, never values.
 */

import { z } from 'zod'

/** The eight required variables, in the order `.env.example` lists them. */
export const REQUIRED_ENV_VARS = [
  'NEXT_PUBLIC_SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'NETLIFY_SITE_ID',
  'NETLIFY_TOKEN',
  'LOCAL_STORAGE_ROOT',
  'REDIS_URL',
  'APP_PASSWORD',
  'SESSION_SECRET',
] as const

export type RequiredEnvVar = (typeof REQUIRED_ENV_VARS)[number]

/**
 * `SESSION_SECRET` is the HS256 signing key for the admin session cookie
 * (`Tech.md` §4.2). 32 characters is the floor for HMAC-SHA256; a shorter key
 * is a real weakness, not a style preference, so it is a hard failure rather
 * than a warning.
 */
const MIN_SESSION_SECRET_LENGTH = 32

const envSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z
    .string()
    .min(1, 'is required')
    .url('must be a valid URL, e.g. https://abcdefgh.supabase.co'),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1, 'is required'),
  NETLIFY_SITE_ID: z.string().min(1, 'is required'),
  NETLIFY_TOKEN: z.string().min(1, 'is required'),
  LOCAL_STORAGE_ROOT: z.string().min(1, 'is required'),
  REDIS_URL: z.string().min(1, 'is required'),
  APP_PASSWORD: z.string().min(1, 'is required'),
  SESSION_SECRET: z
    .string()
    .min(1, 'is required')
    .min(
      MIN_SESSION_SECRET_LENGTH,
      `must be at least ${MIN_SESSION_SECRET_LENGTH} characters (HS256 signing key)`,
    ),
})

export type Env = z.infer<typeof envSchema>

export type EnvValidationResult =
  | { ok: true; env: Env }
  | { ok: false; problems: EnvProblem[] }

export interface EnvProblem {
  name: string
  message: string
}

/**
 * Reads and validates the environment without throwing.
 *
 * Treats an empty or whitespace-only string as absent: `FOO=` in a dotenv file
 * produces `''`, which is a configuration mistake rather than a value, and
 * reporting it as "is required" is more useful than letting it through.
 */
export function validateEnv(source: NodeJS.ProcessEnv = process.env): EnvValidationResult {
  const candidate: Record<string, unknown> = {}
  for (const name of REQUIRED_ENV_VARS) {
    const raw = source[name]
    const trimmed = typeof raw === 'string' ? raw.trim() : raw
    if (trimmed !== undefined && trimmed !== '') candidate[name] = trimmed
  }

  const parsed = envSchema.safeParse(candidate)
  if (parsed.success) return { ok: true, env: parsed.data }

  // safeParse collects every issue, which is what lets us name all missing
  // variables in one message instead of one per restart.
  //
  // A key absent from `candidate` was absent (or empty) in the environment.
  // Zod reports that as "expected string, received undefined", which describes
  // a type error rather than the operator's actual problem — so absence is
  // relabelled before it reaches anyone.
  const problems: EnvProblem[] = parsed.error.issues.map((issue) => {
    const name = String(issue.path[0] ?? '(unknown)')
    const wasAbsent = candidate[name] === undefined
    return {
      name,
      message: wasAbsent ? 'is required, but is not set' : issue.message,
    }
  })

  problems.sort(
    (a, b) =>
      REQUIRED_ENV_VARS.indexOf(a.name as RequiredEnvVar) -
      REQUIRED_ENV_VARS.indexOf(b.name as RequiredEnvVar),
  )

  return { ok: false, problems }
}

export class EnvValidationError extends Error {
  readonly problems: EnvProblem[]

  constructor(problems: EnvProblem[]) {
    super(formatProblems(problems))
    this.name = 'EnvValidationError'
    this.problems = problems
  }
}

function formatProblems(problems: EnvProblem[]): string {
  const lines = [
    '',
    '  Personalizer cannot start — environment is not configured.',
    '',
    `  ${problems.length} of ${REQUIRED_ENV_VARS.length} required variables ${
      problems.length === 1 ? 'is' : 'are'
    } invalid or missing:`,
    '',
    ...problems.map((p) => `    • ${p.name} — ${p.message}`),
    '',
    '  Copy .env.example to .env.local and fill every value.',
    '  See docs/Tech.md §14.1 for what each variable is for.',
    '',
  ]
  return lines.join('\n')
}

let cached: Env | null = null

/**
 * Validates and returns the environment, throwing `EnvValidationError` if any
 * variable is missing or invalid. Call once per process at startup.
 */
export function assertEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (cached) return cached
  const result = validateEnv(source)
  if (!result.ok) throw new EnvValidationError(result.problems)
  cached = result.env
  return cached
}

/**
 * The process-exiting variant lives in `lib/env-node.ts`, not here.
 *
 * Next.js compiles `instrumentation.ts` for the Edge runtime as well as Node,
 * and `process.exit` is unavailable there — keeping it out of this module is
 * what lets the Next server import env validation without a build warning.
 */

/** Test-only: clears the memoized environment. */
export function resetEnvCache(): void {
  cached = null
}
