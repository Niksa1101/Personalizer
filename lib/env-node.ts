/**
 * Node-only environment guard.
 *
 * Split from `lib/env.ts` because Next.js compiles `instrumentation.ts` for the
 * Edge runtime as well as Node, and `process.exit` is not available there.
 * `lib/env.ts` therefore stays runtime-agnostic and this module — which only
 * ever runs in a real Node process (the worker, the seed script) — owns the
 * exiting behaviour.
 */

import { assertEnv, EnvValidationError, type Env } from './env'

/**
 * Validates the environment, or prints every problem and exits non-zero.
 *
 * Exits rather than throws so an operator sees a readable list of missing
 * variables instead of a stack trace wrapped around one.
 */
export function assertEnvOrExit(source: NodeJS.ProcessEnv = process.env): Env {
  try {
    return assertEnv(source)
  } catch (error) {
    if (error instanceof EnvValidationError) {
      console.error(error.message)
      process.exit(1)
    }
    throw error
  }
}
