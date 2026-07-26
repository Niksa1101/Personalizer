import { unauthorizedResponse, verifySession } from "@/lib/dal"
import {
  encodeSseComment,
  encodeSseEvent,
  subscribeDashboardStream,
} from "@/lib/dashboard-stream"
import {
  getDashboardSnapshot,
  parseDashboardScope,
} from "@/lib/dashboard"
import type { DashboardScope, DashboardSnapshot } from "@/lib/dashboard-types"

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

function parseScope(request: Request): DashboardScope | Response {
  const url = new URL(request.url)
  const scope = parseDashboardScope(
    url.searchParams.get("campaign") ?? undefined,
    url.searchParams.get("archived") ?? undefined,
  )

  if ("error" in scope) {
    return Response.json({ error: scope.error }, { status: 400 })
  }

  return scope
}

export async function GET(request: Request) {
  const authError = await requireSession()
  if (authError) return authError

  const scopeResult = parseScope(request)
  if (scopeResult instanceof Response) return scopeResult

  const url = new URL(request.url)
  if (url.searchParams.get("once") === "1") {
    const snapshot = await getDashboardSnapshot(scopeResult)
    return Response.json(snapshot, {
      headers: { "Cache-Control": "no-store" },
    })
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
    async start(controller) {
      const enqueueSnapshot = (snapshot: DashboardSnapshot) => {
        try {
          controller.enqueue(
            encoder.encode(encodeSseEvent("snapshot", snapshot)),
          )
        } catch {
          cleanup()
        }
      }

      if (request.signal.aborted) {
        cleanup()
        return
      }

      try {
        enqueueSnapshot(await getDashboardSnapshot(scopeResult))
      } catch (error) {
        controller.enqueue(
          encoder.encode(
            encodeSseEvent("error", {
              message:
                error instanceof Error ? error.message : "Failed to load snapshot",
            }),
          ),
        )
      }

      if (request.signal.aborted) {
        cleanup()
        try {
          controller.close()
        } catch {
          // Already closed.
        }
        return
      }

      unsubscribe = subscribeDashboardStream(scopeResult, {
        signal: request.signal,
        enqueue: enqueueSnapshot,
        onOverflow: () => {
          try {
            controller.enqueue(
              encoder.encode(
                encodeSseEvent("overflow", {
                  message: "Scope overflow — poll instead",
                }),
              ),
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
