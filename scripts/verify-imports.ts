/**
 * Phase 0 verification: every declared dependency resolves and exposes the
 * entry point the specification relies on.
 *
 * Kept in the repo because it is cheap to re-run and catches a broken install
 * (a blocked postinstall, a missing native binary) far faster than a failed
 * pipeline run does. Run with `npm run verify:imports`.
 */

import { existsSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
import { Queue, Worker } from 'bullmq'
import Redis from 'ioredis'
import { chromium } from 'playwright'
import ffmpegPath from 'ffmpeg-static'
import ffprobe from 'ffprobe-static'
import { SignJWT, jwtVerify } from 'jose'
import { getCoreRowModel } from '@tanstack/react-table'
import { parse } from 'csv-parse/sync'
import { z } from 'zod'
import { REQUIRED_ENV_VARS, validateEnv } from '../lib/env'
import { assertEnvOrExit } from '../lib/env-node'
import { cn } from '../lib/utils'

const checks: Array<[string, unknown]> = [
  ['@supabase/supabase-js → createClient', createClient],
  ['bullmq → Queue', Queue],
  ['bullmq → Worker', Worker],
  ['ioredis → default', Redis],
  ['playwright → chromium', chromium],
  ['ffmpeg-static → binary path', ffmpegPath],
  ['ffprobe-static → binary path', ffprobe.path],
  ['jose → SignJWT', SignJWT],
  ['jose → jwtVerify', jwtVerify],
  ['@tanstack/react-table → getCoreRowModel', getCoreRowModel],
  ['csv-parse/sync → parse', parse],
  ['zod → z', z],
  ['lib/env → validateEnv', validateEnv],
  ['lib/env → REQUIRED_ENV_VARS', REQUIRED_ENV_VARS],
  ['lib/env-node → assertEnvOrExit', assertEnvOrExit],
  ['lib/utils → cn (shadcn)', cn],
]

let failed = 0

for (const [name, value] of checks) {
  const ok = value !== undefined && value !== null
  if (!ok) failed++
  console.log(`${ok ? 'OK  ' : 'FAIL'}  ${name}`)
}

// The two vendored binaries are downloaded at install time, not shipped in the
// tarball for ffmpeg — an install-script policy that blocks it leaves a
// resolvable module pointing at a file that does not exist.
const binaries: Array<[string, string | null]> = [
  ['ffmpeg binary on disk', ffmpegPath],
  ['ffprobe binary on disk', ffprobe.path],
]

for (const [name, binPath] of binaries) {
  const ok = typeof binPath === 'string' && existsSync(binPath)
  if (!ok) failed++
  console.log(`${ok ? 'OK  ' : 'FAIL'}  ${name} — ${binPath ?? '(null)'}`)
}

const envVarCountOk = REQUIRED_ENV_VARS.length === 8
if (!envVarCountOk) failed++
console.log(
  `${envVarCountOk ? 'OK  ' : 'FAIL'}  lib/env declares exactly 8 required variables (found ${REQUIRED_ENV_VARS.length})`,
)

console.log(failed === 0 ? '\nALL CHECKS PASSED' : `\n${failed} CHECK(S) FAILED`)
process.exit(failed === 0 ? 0 : 1)
