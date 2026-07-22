import { verifySession, withAuth } from '@/lib/dal'

export async function GET() {
  return withAuth(async () => {
    await verifySession()
    return Response.json({ ok: true })
  })
}
