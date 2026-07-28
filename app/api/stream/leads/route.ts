import { unauthorizedResponse, verifySession } from "@/lib/dal"
import {
  encodeSseComment,
  encodeSseEvent,
  subscribeLeadsStream,
} from "@/lib/leads-stream"
import { parseLeadStreamScope } from "@/lib/lead-filters"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** Coupled to client SILENCE_MS — must stay <= SILENCE_MS / 2. */
export const HEARTBEAT_MS = 10_000

async function requireSession(): Promise<Response | null> {
  try {
    await verifySession()
    return null
  } catch {
    return unauthorizedResponse()
  }
}

function parseScope(request: Request) {
  const url = new URL(request.url)
  return parseLeadStreamScope(
    url.searchParams.get("campaign") ?? undefined,
    url.searchParams.get("archived") ?? undefined,
  )
}

export async function GET(request: Request) {
  const authError = await requireSession()
  if (authError) return authError

  const scopeResult = parseScope(request)
  if ("error" in scopeResult) {
    return Response.json({ error: scopeResult.error }, { status: 400 })
  }

  const encoder = new TextEncoder()
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null
  let unsubscribe: (() => void) | null = null
  let closed = false

  const cleanup = () => {
    if (closed) return
    closed = true
    if (heartbeatTimer) clearInterval(heartbeatTimer)
    unsubscribe?.()
    unsubscribe = null
  }

  request.signal.addEventListener("abort", cleanup)

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      if (request.signal.aborted) {
        cleanup()
        return
      }

      unsubscribe = subscribeLeadsStream({
        scope: scopeResult,
        signal: request.signal,
        enqueueChanged: (payload) => {
          try {
            controller.enqueue(
              encoder.encode(encodeSseEvent("changed", payload)),
            )
          } catch {
            cleanup()
          }
        },
        enqueueEvent: (event) => {
          try {
            controller.enqueue(
              encoder.encode(encodeSseEvent("event", event)),
            )
          } catch {
            cleanup()
          }
        },
        enqueueResync: () => {
          try {
            controller.enqueue(encoder.encode(encodeSseEvent("resync", {})))
          } catch {
            cleanup()
          }
        },
        onError: (message) => {
          try {
            controller.enqueue(
              encoder.encode(encodeSseEvent("error", { message })),
            )
          } catch {
            cleanup()
          }
        },
      })

      heartbeatTimer = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(encodeSseComment("ping")))
        } catch {
          cleanup()
        }
      }, HEARTBEAT_MS)
    },
    cancel() {
      cleanup()
    },
  })

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no",
    },
  })
}
