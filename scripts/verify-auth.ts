/**
 * Auth verification against a running dev server (D45).
 * Does not start the server — fails loudly if nothing is listening.
 */

const BASE_URL = 'http://127.0.0.1:3000'
const INVALID_BODY = '{"error":"invalid_credentials"}'

interface CheckResult {
  name: string
  ok: boolean
  detail: string
}

const results: CheckResult[] = []

function pass(name: string, detail = 'ok'): void {
  results.push({ name, ok: true, detail })
  console.log(`PASS  ${name}${detail === 'ok' ? '' : ` — ${detail}`}`)
}

function fail(name: string, detail: string): void {
  results.push({ name, ok: false, detail })
  console.error(`FAIL  ${name} — ${detail}`)
}

async function probeServer(): Promise<boolean> {
  try {
    const response = await fetch(`${BASE_URL}/login`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(3000),
    })
    return response.status >= 200 && response.status < 500
  } catch {
    return false
  }
}

function getSetCookie(response: Response): string | null {
  const headers = response.headers as Headers & {
    getSetCookie?: () => string[]
  }
  if (typeof headers.getSetCookie === 'function') {
    const values = headers.getSetCookie()
    return values.length > 0 ? values.join(', ') : null
  }
  return response.headers.get('set-cookie')
}

function parseCookies(setCookie: string | null): Map<string, string> {
  const jar = new Map<string, string>()
  if (!setCookie) return jar

  for (const part of setCookie.split(/,(?=\s*[^;]+=)/)) {
    const [pair] = part.split(';')
    const eq = pair?.indexOf('=')
    if (eq === undefined || eq <= 0) continue
    const name = pair.slice(0, eq).trim()
    const value = pair.slice(eq + 1).trim()
    jar.set(name, value)
  }

  return jar
}

function tamperSessionCookie(value: string): string {
  const last = value.at(-1) ?? 'a'
  const flipped = last === 'a' ? 'b' : 'a'
  return value.slice(0, -1) + flipped
}

async function main(): Promise<void> {
  const password = process.env.APP_PASSWORD?.trim()
  if (!password) {
    console.error('APP_PASSWORD is not set. Load .env.local or export it before running.')
    process.exit(1)
  }

  if (!(await probeServer())) {
    console.error(
      `Personalizer dev server is not reachable at ${BASE_URL}.\n` +
        'Start it with `npm run dev` in another terminal, then rerun `npm run verify:auth`.',
    )
    process.exit(1)
  }

  let sessionCookie = ''

  // 1. POST /api/logout with no cookie
  {
    const response = await fetch(`${BASE_URL}/api/logout`, { method: 'POST' })
    const setCookie = getSetCookie(response)
    const jar = parseCookies(setCookie)
    const granted = jar.get('pz_session')

    if (response.status === 200 && !granted) {
      pass('POST /api/logout without cookie returns 200 and does not grant a session')
    } else {
      fail(
        'POST /api/logout without cookie returns 200 and does not grant a session',
        `status=${response.status}, set-cookie=${setCookie ?? '(none)'}`,
      )
    }
  }

  // 2. GET / with no cookie redirects to login
  {
    const response = await fetch(`${BASE_URL}/`, { redirect: 'manual' })
    const location = response.headers.get('location') ?? ''
    if ((response.status === 307 || response.status === 308) && location.includes('/login')) {
      pass('GET / without cookie redirects to /login')
    } else {
      fail(
        'GET / without cookie redirects to /login',
        `status=${response.status}, location=${location || '(none)'}`,
      )
    }
  }

  // 3. GET /login with no cookie
  {
    const response = await fetch(`${BASE_URL}/login`, { redirect: 'manual' })
    if (response.status === 200) {
      pass('GET /login without cookie returns 200')
    } else {
      fail('GET /login without cookie returns 200', `status=${response.status}`)
    }
  }

  // 4. Wrong password
  {
    const response = await fetch(`${BASE_URL}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'definitely-wrong-password' }),
    })
    const body = await response.text()
    if (response.status === 401 && body === INVALID_BODY) {
      pass('POST /api/login with wrong password returns 401 invalid_credentials')
    } else {
      fail(
        'POST /api/login with wrong password returns 401 invalid_credentials',
        `status=${response.status}, body=${body}`,
      )
    }
  }

  // 5. Correct password
  {
    const response = await fetch(`${BASE_URL}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    })
    const setCookie = getSetCookie(response)
    const jar = parseCookies(setCookie)
    sessionCookie = jar.get('pz_session') ?? ''

    const attrs = (setCookie ?? '').toLowerCase()
    const cookieOk =
      response.status === 200 &&
      sessionCookie.length > 0 &&
      attrs.includes('httponly') &&
      attrs.includes('samesite=lax') &&
      attrs.includes('path=/') &&
      attrs.includes('max-age=604800')

    if (cookieOk) {
      pass('POST /api/login with correct password sets pz_session cookie')
    } else {
      fail(
        'POST /api/login with correct password sets pz_session cookie',
        `status=${response.status}, set-cookie=${setCookie ?? '(none)'}`,
      )
    }
  }

  // 6. GET / with session cookie
  if (sessionCookie) {
    const response = await fetch(`${BASE_URL}/`, {
      redirect: 'manual',
      headers: { Cookie: `pz_session=${sessionCookie}` },
    })
    if (response.status === 200) {
      pass('GET / with valid session cookie returns 200')
    } else {
      fail(
        'GET / with valid session cookie returns 200',
        `status=${response.status}`,
      )
    }
  } else {
    fail('GET / with valid session cookie returns 200', 'no session cookie from login')
  }

  // 7. Tampered cookie redirects to login
  if (sessionCookie) {
    const tampered = tamperSessionCookie(sessionCookie)
    const response = await fetch(`${BASE_URL}/`, {
      redirect: 'manual',
      headers: { Cookie: `pz_session=${tampered}` },
    })
    const location = response.headers.get('location') ?? ''
    if ((response.status === 307 || response.status === 308) && location.includes('/login')) {
      pass('GET / with tampered session cookie redirects to /login')
    } else {
      fail(
        'GET / with tampered session cookie redirects to /login',
        `status=${response.status}, location=${location || '(none)'}`,
      )
    }
  } else {
    fail('GET / with tampered session cookie redirects to /login', 'no session cookie from login')
  }

  // 8. Protected API route without cookie returns 401, not redirect
  {
    const response = await fetch(`${BASE_URL}/api/session`, { redirect: 'manual' })
    const body = await response.text()
    if (response.status === 401 && body.includes('unauthorized')) {
      pass('GET /api/session without cookie returns 401 JSON')
    } else {
      fail(
        'GET /api/session without cookie returns 401 JSON',
        `status=${response.status}, body=${body}`,
      )
    }
  }

  // 9. Six wrong-password posts — identical 401 bodies
  {
    const bodies: string[] = []
    let all401 = true
    for (let i = 0; i < 6; i++) {
      const response = await fetch(`${BASE_URL}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: `wrong-${i}` }),
      })
      bodies.push(await response.text())
      if (response.status !== 401) all401 = false
    }

    const identical = bodies.every((body) => body === INVALID_BODY)
    if (all401 && identical) {
      pass('Six wrong-password attempts all return identical 401 invalid_credentials')
    } else {
      fail(
        'Six wrong-password attempts all return identical 401 invalid_credentials',
        `statuses/bodies=${JSON.stringify(bodies)}`,
      )
    }
  }

  // 10. Correct password immediately after lockout still 401
  {
    const response = await fetch(`${BASE_URL}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    })
    const body = await response.text()
    if (response.status === 401 && body === INVALID_BODY) {
      pass('Correct password during lockout still returns 401 invalid_credentials')
    } else {
      fail(
        'Correct password during lockout still returns 401 invalid_credentials',
        `status=${response.status}, body=${body}`,
      )
    }
  }

  const failed = results.filter((result) => !result.ok)
  const passed = results.filter((result) => result.ok)

  console.log('')
  console.log(
    `Summary: ${passed.length} passed, ${failed.length} failed`,
  )
  console.log('')
  console.log(
    'Reminder: restart the dev server before a manual browser pass — the lockout assertions poison the in-memory limiter.',
  )

  if (failed.length > 0) {
    process.exit(1)
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
