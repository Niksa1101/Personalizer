import { strict as assert } from 'node:assert'
import { beforeEach, describe, it } from 'node:test'

import {
  assertEnv,
  EnvValidationError,
  REQUIRED_ENV_VARS,
  resetEnvCache,
  validateEnv,
} from './env'

// Next's types declare NODE_ENV as required on ProcessEnv, which these fixtures
// have no reason to carry — validateEnv() only ever reads REQUIRED_ENV_VARS.
// One cast here beats threading a meaningless field through every case.
function env(vars: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return vars as NodeJS.ProcessEnv
}

const EMPTY = env({})

function completeEnv(): NodeJS.ProcessEnv {
  return env({
    NEXT_PUBLIC_SUPABASE_URL: 'https://abcdefgh.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
    NETLIFY_SITE_ID: 'site-id',
    NETLIFY_TOKEN: 'netlify-token',
    LOCAL_STORAGE_ROOT: 'C:\\personalizer-media',
    REDIS_URL: 'redis://127.0.0.1:6379',
    APP_PASSWORD: 'a-real-password',
    SESSION_SECRET: 's'.repeat(32),
  })
}

beforeEach(() => {
  resetEnvCache()
})

describe('validateEnv', () => {
  it('accepts a complete environment', () => {
    const result = validateEnv(completeEnv())
    assert.equal(result.ok, true)
  })

  it('names every missing variable at once, in .env.example order', () => {
    const result = validateEnv(EMPTY)
    assert.equal(result.ok, false)
    if (result.ok) return

    // The whole point of the module: a half-configured system that starts and
    // then dies on lead 40 costs more than one that refuses to boot.
    assert.equal(result.problems.length, 8)
    assert.deepEqual(
      result.problems.map((p) => p.name),
      [...REQUIRED_ENV_VARS],
    )
    for (const problem of result.problems) {
      assert.equal(problem.message, 'is required, but is not set')
    }
  })

  it('treats an empty or whitespace-only value as absent, not as a type error', () => {
    // `APP_PASSWORD=` in a dotenv file yields ''. Zod would report "expected
    // string, received undefined", which describes our schema rather than the
    // operator's problem.
    const result = validateEnv({ ...completeEnv(), APP_PASSWORD: '   ' })
    assert.equal(result.ok, false)
    if (result.ok) return

    assert.equal(result.problems.length, 1)
    assert.equal(result.problems[0]?.name, 'APP_PASSWORD')
    assert.equal(result.problems[0]?.message, 'is required, but is not set')
  })

  it('rejects a SESSION_SECRET below the HS256 floor with a length message', () => {
    const result = validateEnv({ ...completeEnv(), SESSION_SECRET: 's'.repeat(31) })
    assert.equal(result.ok, false)
    if (result.ok) return

    assert.equal(result.problems.length, 1)
    assert.equal(result.problems[0]?.name, 'SESSION_SECRET')
    // Present but too short is a different problem from absent, and must read
    // that way or the operator deletes a working value trying to fix it.
    assert.match(result.problems[0]!.message, /at least 32 characters/)
  })

  it('rejects a malformed Supabase URL', () => {
    const result = validateEnv({ ...completeEnv(), NEXT_PUBLIC_SUPABASE_URL: 'abcdefgh' })
    assert.equal(result.ok, false)
    if (result.ok) return

    assert.equal(result.problems[0]?.name, 'NEXT_PUBLIC_SUPABASE_URL')
    assert.match(result.problems[0]!.message, /valid URL/)
  })
})

describe('assertEnv', () => {
  it('returns the parsed environment and memoizes it', () => {
    const parsed = assertEnv(completeEnv())
    assert.equal(parsed.APP_PASSWORD, 'a-real-password')
    // Second call ignores its argument — the cache is what makes calling this
    // per-request in a route handler free.
    assert.equal(assertEnv(EMPTY).APP_PASSWORD, 'a-real-password')
  })

  it('throws EnvValidationError listing every problem', () => {
    assert.throws(
      () => assertEnv(EMPTY),
      (error: unknown) => {
        assert.ok(error instanceof EnvValidationError)
        assert.equal(error.problems.length, 8)
        for (const name of REQUIRED_ENV_VARS) {
          assert.ok(error.message.includes(name), `message must name ${name}`)
        }
        return true
      },
    )
  })
})
