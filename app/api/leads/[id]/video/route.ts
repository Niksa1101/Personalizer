import { unauthorizedResponse, verifySession } from "@/lib/dal"
import {
  contentTypeFromExtension,
  loadCampaignLeadMediaContext,
  resolveContainedLocalPath,
} from "@/lib/lead-media"
import { serveLocalFile } from "@/lib/local-file"

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
  const row = await loadCampaignLeadMediaContext(id)
  if (!row?.videos) {
    return new Response(null, { status: 404 })
  }

  const video = Array.isArray(row.videos) ? row.videos[0] : row.videos
  if (!video) return new Response(null, { status: 404 })

  if (video.web_public_url) {
    return Response.redirect(video.web_public_url, 302)
  }

  const relPath = video.web_path ?? video.master_path
  const abs = resolveContainedLocalPath(relPath)
  if (!abs) return new Response(null, { status: 404 })

  const contentType = contentTypeFromExtension(abs)
  if (!contentType) return new Response(null, { status: 404 })

  const response = await serveLocalFile(request, abs, contentType)
  response.headers.set("Cache-Control", "private, no-store")
  return response
}
