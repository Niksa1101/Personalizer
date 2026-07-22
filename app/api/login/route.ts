import {
  checkOrigin,
  setSessionCookie,
} from '@/lib/dal'
import {
  clearFailures,
  clientKey,
  isLockedOut,
  recordFailure,
} from '@/lib/rate-limit'
import { passwordMatches, signSession } from '@/lib/session'

function invalidCredentialsResponse(): Response {
  return Response.json({ error: 'invalid_credentials' }, { status: 401 })
}

export async function POST(request: Request) {
  const originError = checkOrigin(request)
  if (originError) return originError

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: 'bad_request' }, { status: 400 })
  }

  if (
    typeof body !== 'object' ||
    body === null ||
    !('password' in body) ||
    typeof (body as { password: unknown }).password !== 'string'
  ) {
    return Response.json({ error: 'bad_request' }, { status: 400 })
  }

  const { password } = body as { password: string; next?: string }
  const key = clientKey(request.headers)

  if (isLockedOut(key)) {
    return invalidCredentialsResponse()
  }

  const expected = process.env.APP_PASSWORD ?? ''
  if (!passwordMatches(password, expected)) {
    recordFailure(key)
    return invalidCredentialsResponse()
  }

  clearFailures(key)
  const token = await signSession()
  await setSessionCookie(token)

  return Response.json({ ok: true })
}
