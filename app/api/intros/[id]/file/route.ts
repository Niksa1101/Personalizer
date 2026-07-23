import { unauthorizedResponse, verifySession } from "@/lib/dal"
import { getIntro } from "@/lib/intros"
import { serveLocalFile } from "@/lib/local-file"
import { storageAbs } from "@/lib/storage"

export const runtime = "nodejs"

type RouteContext = {
  params: Promise<{ id: string }>
}

export async function GET(request: Request, context: RouteContext) {
  try {
    await verifySession()
  } catch {
    return unauthorizedResponse()
  }

  const { id } = await context.params
  const intro = await getIntro(id)
  if (!intro) {
    return new Response(null, { status: 404 })
  }

  return serveLocalFile(request, storageAbs(intro.local_path), "video/mp4")
}
