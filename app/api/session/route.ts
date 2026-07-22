/**
 * Session probe.
 *
 * Exists so `npm run verify:auth` (scripts/verify-auth.ts, check 8) has a
 * protected API route to assert the D24 contract against: an unauthenticated
 * request to /api/* must return 401 JSON from the handler, never a redirect.
 * That is a Phase 2 exit criterion, and until Phase 4 adds real endpoints there
 * is no other protected route to test it on.
 *
 * Returns nothing about the session but whether there is one — no expiry, no
 * claims. Keep it that way; it is a test fixture, not an API.
 */

import { verifySession, withAuth } from '@/lib/dal'

export async function GET() {
  return withAuth(async () => {
    await verifySession()
    return Response.json({ ok: true })
  })
}
