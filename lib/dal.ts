import 'server-only'

import { cookies } from 'next/headers'
import { cache } from 'react'

import {
  SESSION_COOKIE_NAME,
  sessionCookieOptions,
  verifySessionToken,
  type SessionPayload,
} from '@/lib/session'
import { originsMatch } from '@/lib/origin'

export class UnauthorizedError extends Error {
  constructor(message = 'Unauthorized') {
    super(message)
    this.name = 'UnauthorizedError'
  }
}

export const verifySession = cache(async (): Promise<SessionPayload> => {
  const cookieStore = await cookies()
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value
  if (!token) throw new UnauthorizedError()

  const session = await verifySessionToken(token)
  if (!session) throw new UnauthorizedError()

  return session
})

export async function getSession(): Promise<SessionPayload | null> {
  const cookieStore = await cookies()
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value
  if (!token) return null
  return verifySessionToken(token)
}

export function unauthorizedResponse(): Response {
  return Response.json({ error: 'unauthorized' }, { status: 401 })
}

export async function withAuth<T>(fn: () => Promise<T>): Promise<T | Response> {
  try {
    return await fn()
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return unauthorizedResponse()
    }
    throw error
  }
}

export async function setSessionCookie(token: string): Promise<void> {
  const cookieStore = await cookies()
  cookieStore.set(SESSION_COOKIE_NAME, token, sessionCookieOptions())
}

export async function clearSessionCookie(): Promise<void> {
  const cookieStore = await cookies()
  cookieStore.set(SESSION_COOKIE_NAME, '', {
    ...sessionCookieOptions(),
    maxAge: 0,
  })
}

/** If Origin is present and does not match the request host, return 403 (D44). */
export function checkOrigin(request: Request): Response | null {
  const origin = request.headers.get('Origin')
  if (!origin) return null

  const requestOrigin = new URL(request.url).origin
  if (!originsMatch(origin, requestOrigin)) {
    return Response.json({ error: 'forbidden' }, { status: 403 })
  }

  return null
}
