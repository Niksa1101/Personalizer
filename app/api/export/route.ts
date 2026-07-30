import {
  unauthorizedResponse,
  verifySession,
} from "@/lib/dal"
import type { Json } from "@/lib/database.types"
import {
  buildExportCsv,
  buildExportFilename,
  fetchExportRows,
  parseExportParams,
  resolveExportCampaignRef,
} from "@/lib/export"
import { getSupabaseAdmin } from "@/lib/supabase"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const BOM = String.fromCharCode(0xfeff)

function jsonError(message: string, status: number): Response {
  return Response.json({ error: message }, { status })
}

async function writeExportLog(input: {
  level: "info" | "error"
  message: string
  meta: Json
}): Promise<void> {
  const { error } = await getSupabaseAdmin().from("logs").insert({
    level: input.level,
    scope: "web",
    message: input.message,
    meta: input.meta,
  })
  if (error) {
    console.error("[export] failed to write log:", error.message)
  }
}

export async function GET(request: Request) {
  try {
    await verifySession()
  } catch {
    return unauthorizedResponse()
  }

  const url = new URL(request.url)
  const parsed = parseExportParams(url.searchParams)
  if ("error" in parsed) {
    return jsonError(parsed.error, 400)
  }

  const now = new Date()
  let campaignRef: string | null = null
  let filename = buildExportFilename(null, parsed.statuses, now)

  try {
    campaignRef = await resolveExportCampaignRef(parsed.campaignId)
    filename = buildExportFilename(campaignRef, parsed.statuses, now)

    const { rows, skipped, missingVideo } = await fetchExportRows(parsed)
    const csv = buildExportCsv(rows)
    const body = new TextEncoder().encode(BOM + csv)

    await writeExportLog({
      level: "info",
      message: "CSV export completed",
      meta: {
        campaignId: parsed.campaignId ?? null,
        statuses: parsed.statuses,
        rowCount: rows.length,
        skipped,
        missingVideo,
        filename,
      },
    })

    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "private, no-store",
        "X-Export-Row-Count": String(rows.length),
        "X-Export-Skipped": String(skipped),
        "X-Export-Missing-Video": String(missingVideo),
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Export failed"
    console.error("[export]", message)
    await writeExportLog({
      level: "error",
      message: "CSV export failed",
      meta: {
        campaignId: parsed.campaignId ?? null,
        statuses: parsed.statuses,
        error: message,
        filename,
      },
    })
    return jsonError("Export failed — check the logs", 500)
  }
}
