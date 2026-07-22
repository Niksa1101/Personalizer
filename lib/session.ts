import { createHash, timingSafeEqual } from 'node:crypto'

import { SignJWT, jwtVerify } from 'jose'

const ALG = 'HS256'

/** Duplicated as a literal in proxy.ts — see D26. Keep them in sync. */
export const SESSION_COOKIE_NAME = 'pz_session'
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7 // 7 days, absolute (D3)

export interface SessionPayload {
  sub: 'admin'
  iat: number
  exp: number
}

let cachedKey: Uint8Array | null = null

function secretKey(): Uint8Array {
  if (cachedKey) return cachedKey
  const secret = process.env.SESSION_SECRET?.trim()
  // lib/env.ts already refuses to boot without this; the guard is here because
  // this module is reachable from contexts that did not run the boot check.
  if (!secret || secret.length < 32) {
    throw new Error('SESSION_SECRET is missing or shorter than 32 characters')
  }
  cachedKey = new TextEncoder().encode(secret)
  return cachedKey
}

export async function signSession(now: number = Date.now()): Promise<string> {
  const issuedAt = Math.floor(now / 1000)
  return new SignJWT({})
    .setProtectedHeader({ alg: ALG })
    .setSubject('admin')
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + SESSION_MAX_AGE_SECONDS)
    .sign(secretKey())
}

/** Returns null on any failure — bad signature, expiry, wrong alg, wrong subject. */
export async function verifySessionToken(token: string): Promise<SessionPayload | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey(), {
      algorithms: [ALG], // pinned: a token never chooses its own algorithm (D7)
      clockTolerance: 0, // D7
    })
    if (payload.sub !== 'admin') return null
    if (typeof payload.iat !== 'number' || typeof payload.exp !== 'number') return null
    return { sub: 'admin', iat: payload.iat, exp: payload.exp }
  } catch {
    return null
  }
}

export function sessionCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production', // D4
    sameSite: 'lax' as const,
    path: '/',
    maxAge: SESSION_MAX_AGE_SECONDS,
  }
}

/** Timing-safe password check (D8). SHA-256 digests are always 32 bytes, so
 *  timingSafeEqual never throws on length and no length is leaked. */
export function passwordMatches(candidate: string, expected: string): boolean {
  const a = createHash('sha256').update(candidate, 'utf8').digest()
  const b = createHash('sha256').update(expected, 'utf8').digest()
  return timingSafeEqual(a, b)
}
