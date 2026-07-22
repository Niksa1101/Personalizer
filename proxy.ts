import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

// Duplicated from lib/session.ts on purpose: proxy must not import from lib/,
// or `server-only` and `jose` get dragged into it. Keep the two in sync. (D26)
const SESSION_COOKIE_NAME = 'pz_session'

/** Where the layout reads the current path from. See below. */
const PATHNAME_HEADER = 'x-pathname'

export function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname + request.nextUrl.search

  // Presence only — never a signature check. The real boundary is
  // verifySession() inside every handler (Tech.md §4.2, D25).
  if (request.cookies.get(SESSION_COOKIE_NAME)?.value) {
    // A present-but-INVALID cookie (expired, tampered, signed with a rotated
    // secret) reaches here and is waved through, because only the DAL can tell
    // the difference. app/(app)/layout.tsx is what catches it — and a layout
    // gets no pathname of its own, so it cannot rebuild the `?next=` below.
    // Forwarding the path is the mechanism the Next docs prescribe for
    // proxy → app communication ("use headers, cookies, rewrites, redirects,
    // or the URL" — proxy.md). After seven days every session expires, so this
    // is the common path, not the exotic one. (D46)
    const headers = new Headers(request.headers)
    headers.set(PATHNAME_HEADER, pathname)
    return NextResponse.next({ request: { headers } })
  }

  // API routes must 401 from their own handler, never redirect (D24) — that is
  // exactly what the phase's curl exit criterion checks.
  if (request.nextUrl.pathname.startsWith('/api/')) {
    return NextResponse.next()
  }

  const url = new URL('/login', request.url)
  if (pathname && pathname !== '/') url.searchParams.set('next', pathname)
  return NextResponse.redirect(url)
}

// `api/login` and `api/logout` MUST be excluded, or the proxy redirects the very
// request that creates a session. This corrects Tech.md §4.1, whose matcher
// omits them. (D22)
//
// The three exclusions are anchored with `(?:/|$)` so they exclude those exact
// routes rather than every path merely STARTING with them — bare `login` also
// waved through `/loginanything`. Nothing lives at those paths today; anchoring
// keeps it that way by construction instead of by luck.
export const config = {
  matcher: [
    '/((?!login(?:/|$)|api/login(?:/|$)|api/logout(?:/|$)|_next/static|_next/image|favicon.ico|robots.txt|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)',
  ],
}
