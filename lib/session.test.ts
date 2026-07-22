import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

import { SignJWT } from 'jose'

import {
  SESSION_MAX_AGE_SECONDS,
  passwordMatches,
  signSession,
  verifySessionToken,
} from './session'

// secretKey() reads SESSION_SECRET on first *call* and memoizes from there, not
// at import time — so a plain static import is safe as long as this assignment
// runs before any test body does.
const SECRET = 'k'.repeat(48)
process.env.SESSION_SECRET = SECRET

const key = new TextEncoder().encode(SECRET)
const otherKey = new TextEncoder().encode('x'.repeat(48))

describe('passwordMatches', () => {
  it('accepts an exact match', () => {
    assert.equal(passwordMatches('correct horse', 'correct horse'), true)
  })

  it('rejects a wrong password', () => {
    assert.equal(passwordMatches('wrong', 'correct horse'), false)
  })

  it('rejects unequal lengths without throwing', () => {
    // Both sides are SHA-256 digests, so timingSafeEqual always gets two
    // 32-byte buffers and no length is leaked through an exception.
    assert.doesNotThrow(() => passwordMatches('a', 'a-much-longer-password'))
    assert.equal(passwordMatches('a', 'a-much-longer-password'), false)
    assert.equal(passwordMatches('', 'not-empty'), false)
  })

  it('is not fooled by an empty expected password', () => {
    // The login route must never reach this with '' — see the assertEnv() call
    // in app/api/login/route.ts. Recorded here so the hazard stays visible.
    assert.equal(passwordMatches('', ''), true)
  })
})

describe('session tokens', () => {
  it('round-trips a signed session', async () => {
    const now = Date.now()
    const session = await verifySessionToken(await signSession(now))

    assert.ok(session)
    assert.equal(session.sub, 'admin')
    assert.equal(session.exp - session.iat, SESSION_MAX_AGE_SECONDS)
  })

  it('returns null for a tampered token', async () => {
    const token = await signSession()
    const tampered = token.slice(0, -1) + (token.endsWith('a') ? 'b' : 'a')

    assert.equal(await verifySessionToken(tampered), null)
  })

  it('returns null for a token signed with a different secret', async () => {
    const foreign = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('admin')
      .setIssuedAt()
      .setExpirationTime('7d')
      .sign(otherKey)

    assert.equal(await verifySessionToken(foreign), null)
  })

  it('returns null for a valid signature with the wrong subject', async () => {
    const wrongSubject = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('root')
      .setIssuedAt()
      .setExpirationTime('7d')
      .sign(key)

    assert.equal(await verifySessionToken(wrongSubject), null)
  })

  it('returns null for an expired token, with no clock tolerance (D7)', async () => {
    const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000
    assert.equal(await verifySessionToken(await signSession(eightDaysAgo)), null)
  })

  it('returns null for a token that expired one second ago', async () => {
    const justExpired = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('admin')
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) - 1)
      .sign(key)

    assert.equal(await verifySessionToken(justExpired), null)
  })

  it('returns null for a malformed token', async () => {
    assert.equal(await verifySessionToken('not-a-jwt'), null)
    assert.equal(await verifySessionToken(''), null)
  })
})
