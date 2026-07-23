import { checkOrigin, unauthorizedResponse, verifySession } from "@/lib/dal"
import {
  commitImportSchema,
  refreshPreviewSchema,
} from "@/lib/import-types"
import {
  commitImport,
  createImportPreview,
  ImportCampaignNotFoundError,
  ImportTempNotFoundError,
  previewImportFromToken,
} from "@/lib/imports"

export const runtime = "nodejs"

const CSV_MAX_BYTES = 10 * 1024 * 1024

function jsonError(message: string, status: number): Response {
  return Response.json({ error: message }, { status })
}

async function requireSession(): Promise<Response | null> {
  try {
    await verifySession()
    return null
  } catch {
    return unauthorizedResponse()
  }
}

export async function POST(request: Request) {
  const originError = checkOrigin(request)
  if (originError) return originError

  const authError = await requireSession()
  if (authError) return authError

  const contentType = request.headers.get("content-type") ?? ""

  if (contentType.includes("multipart/form-data")) {
    return handleInitialPreview(request)
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return jsonError("Invalid JSON body.", 400)
  }

  const commitParsed = commitImportSchema.safeParse(body)
  if (commitParsed.success) {
    return handleCommit(commitParsed.data)
  }

  const refreshParsed = refreshPreviewSchema.safeParse(body)
  if (refreshParsed.success) {
    return handleRefreshPreview(refreshParsed.data)
  }

  return jsonError("Unrecognized import request.", 400)
}

async function handleInitialPreview(request: Request): Promise<Response> {
  const contentLength = request.headers.get("content-length")
  if (contentLength) {
    const bytes = Number.parseInt(contentLength, 10)
    if (!Number.isNaN(bytes) && bytes > CSV_MAX_BYTES) {
      return jsonError("CSV file is over 10 MB.", 413)
    }
  }

  const formData = await request.formData()
  const file = formData.get("file")
  const campaignId = formData.get("campaignId")

  if (!(file instanceof File)) {
    return jsonError("Choose a CSV file to import.", 400)
  }

  if (typeof campaignId !== "string" || !campaignId) {
    return jsonError("Choose a target campaign.", 400)
  }

  if (file.size > CSV_MAX_BYTES) {
    return jsonError("CSV file is over 10 MB.", 413)
  }

  try {
    const preview = await createImportPreview(campaignId, file)
    return Response.json(preview)
  } catch (error) {
    if (error instanceof ImportCampaignNotFoundError) {
      return jsonError(error.message, 404)
    }

    const message =
      error instanceof Error ? error.message : "Failed to preview CSV import."
    return jsonError(message, 500)
  }
}

async function handleRefreshPreview(
  input: ReturnType<typeof refreshPreviewSchema.parse>,
): Promise<Response> {
  try {
    const preview = await previewImportFromToken(
      input.campaignId,
      input.token,
      input.mapping,
    )
    return Response.json({ token: input.token, ...preview })
  } catch (error) {
    if (error instanceof ImportCampaignNotFoundError) {
      return jsonError(error.message, 404)
    }
    if (error instanceof ImportTempNotFoundError) {
      return jsonError(error.message, 410)
    }

    const message =
      error instanceof Error ? error.message : "Failed to refresh import preview."
    return jsonError(message, 500)
  }
}

async function handleCommit(
  input: ReturnType<typeof commitImportSchema.parse>,
): Promise<Response> {
  try {
    const result = await commitImport(input)
    return Response.json({
      batchId: result.batchId,
      slug: result.slug,
      counts: result.counts,
    })
  } catch (error) {
    if (error instanceof ImportCampaignNotFoundError) {
      return jsonError(error.message, 404)
    }
    if (error instanceof ImportTempNotFoundError) {
      return jsonError(error.message, 410)
    }

    const message =
      error instanceof Error ? error.message : "Failed to commit CSV import."
    return jsonError(message, 500)
  }
}
