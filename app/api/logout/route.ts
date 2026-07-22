import { checkOrigin, clearSessionCookie } from '@/lib/dal'

export async function POST(request: Request) {
  const originError = checkOrigin(request)
  if (originError) return originError

  await clearSessionCookie()
  return Response.json({ ok: true })
}
