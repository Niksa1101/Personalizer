import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

// Duplicated from lib/session.ts on purpose: proxy must not import from lib/,
// or `server-only` and `jose` get dragged into it. Keep the two in sync. (D26)
const SESSION_COOKIE_NAME = 'pz_session'

export function proxy(request: NextRequest) {
  // Presence only — never a signature check. The real boundary is
  // verifySession() inside every handler (Tech.md §4.2, D25).
  if (request.cookies.get(SESSION_COOKIE_NAME)?.value) {
    return NextResponse.next()
  }

  // API routes must 401 from their own handler, never redirect (D24) — that is
  // exactly what the phase's curl exit criterion checks.
  if (request.nextUrl.pathname.startsWith('/api/')) {
    return NextResponse.next()
  }

  const url = new URL('/login', request.url)
  const next = request.nextUrl.pathname + request.nextUrl.search
  if (next && next !== '/') url.searchParams.set('next', next)
  return NextResponse.redirect(url)
}

// `api/login` and `api/logout` MUST be excluded, or the proxy redirects the very
// request that creates a session. This corrects Tech.md §4.1, whose matcher
// omits them. (D22)
export const config = {
  matcher: [
    '/((?!login|api/login|api/logout|_next/static|_next/image|favicon.ico|robots.txt|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)',
  ],
}
