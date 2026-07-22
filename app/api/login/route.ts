import { checkOrigin, setSessionCookie } from '@/lib/dal'
import { assertEnv } from '@/lib/env'
import { clearFailures, isLockedOut, recordFailure } from '@/lib/rate-limit'
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

  const { password } = body as { password: string }

  if (isLockedOut()) {
    return invalidCredentialsResponse()
  }

  // The validated environment, not raw process.env: passwordMatches('', '') is
  // true, so a `?? ''` fallback would turn a missing APP_PASSWORD into an open
  // door. assertEnv() is memoized and throws if the variable is absent, which
  // makes a misconfiguration a 500 rather than a bypass.
  const { APP_PASSWORD } = assertEnv()
  if (!passwordMatches(password, APP_PASSWORD)) {
    recordFailure()
    return invalidCredentialsResponse()
  }

  clearFailures()
  const token = await signSession()
  await setSessionCookie(token)

  return Response.json({ ok: true })
}
