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

  const url = new URL(request.url)
  const which = url.searchParams.get("which")
  if (which !== "before" && which !== "after") {
    return new Response(null, { status: 400 })
  }

  const { id } = await context.params
  const row = await loadCampaignLeadMediaContext(id)
  if (!row?.recordings) {
    return new Response(null, { status: 404 })
  }

  const recording = Array.isArray(row.recordings)
    ? row.recordings[0]
    : row.recordings

  if (!recording) return new Response(null, { status: 404 })

  const relPath =
    which === "before"
      ? recording.screenshot_before_path
      : recording.screenshot_after_path

  const abs = resolveContainedLocalPath(relPath)
  if (!abs) return new Response(null, { status: 404 })

  const contentType = contentTypeFromExtension(abs)
  if (!contentType?.startsWith("image/")) {
    return new Response(null, { status: 404 })
  }

  const response = await serveLocalFile(request, abs, contentType)
  response.headers.set("Cache-Control", "private, no-store")
  return response
}
