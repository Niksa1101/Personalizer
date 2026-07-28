import { unauthorizedResponse, verifySession } from "@/lib/dal"
import { buildQueueHealth } from "@/lib/queue-health"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(request: Request): Promise<Response> {
  try {
    await verifySession()
  } catch {
    return unauthorizedResponse()
  }

  const url = new URL(request.url)
  const detail = url.searchParams.get("detail") === "1"

  const health = await buildQueueHealth({ detail })

  return Response.json(health, {
    headers: {
      "Cache-Control": "no-store",
    },
  })
}
