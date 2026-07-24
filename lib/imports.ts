import "server-only"

import { randomUUID } from "node:crypto"
import { createWriteStream } from "node:fs"
import { mkdir, readFile } from "node:fs/promises"
import path from "node:path"
import { Readable } from "node:stream"
import type { ReadableStream as NodeReadableStream } from "node:stream/web"
import { pipeline } from "node:stream/promises"

import { getCampaign } from "@/lib/campaigns"
import type { Json } from "@/lib/database.types"
import { parseImportCsv } from "@/lib/import-parse"
import type {
  CommitImportInput,
  ExistsListEntry,
  ImportBatchRow,
  ImportCommitRpcResult,
  ImportCounts,
  ParsedImportRow,
  PreviewResult,
  RejectedRow,
} from "@/lib/import-types"
import { moveFile } from "@/lib/local-file"
import { slugFromName } from "@/lib/slug"
import {
  importBatchCsvRelPath,
  importUploadTempRelPath,
  storageAbs,
} from "@/lib/storage"
import { enqueueLead } from "@/lib/queue"
import { getSupabaseAdmin } from "@/lib/supabase"

export type ImportBatchWithCampaign = ImportBatchRow & {
  campaign: { id: string; name: string }
}

export class ImportTempNotFoundError extends Error {
  constructor(token: string) {
    super(`Import preview expired or not found (${token}). Upload the CSV again.`)
    this.name = "ImportTempNotFoundError"
  }
}

export class ImportCampaignNotFoundError extends Error {
  constructor(id: string) {
    super(`Campaign not found: ${id}`)
    this.name = "ImportCampaignNotFoundError"
  }
}

function rowToRpc(row: ParsedImportRow): Record<string, unknown> {
  return {
    website_url: row.website_url,
    email: row.email,
    company: row.company,
    first_name: row.first_name,
    last_name: row.last_name,
    full_name: row.full_name,
    phone: row.phone,
    city: row.city,
    state: row.state,
    country: row.country,
    industry: row.industry,
    skip: row.skip,
    raw: row.raw,
  }
}

export function parsedRowsToRpc(rows: ParsedImportRow[]): Json {
  return rows.map(rowToRpc) as Json
}

export async function batchSlugExists(slug: string): Promise<boolean> {
  const { data, error } = await getSupabaseAdmin()
    .from("import_batches")
    .select("id")
    .eq("slug", slug)
    .limit(1)

  if (error) {
    throw new Error(`Failed to check import batch slug: ${error.message}`)
  }

  return (data?.length ?? 0) > 0
}

/** Append -2, -3, … until the slug is unique across import_batches. */
export async function resolveUniqueBatchSlug(baseSlug: string): Promise<string> {
  const normalized = baseSlug || "import"
  let candidate = normalized
  let suffix = 2

  while (await batchSlugExists(candidate)) {
    candidate = `${normalized}-${suffix}`
    suffix += 1
  }

  return candidate
}

export async function assertCampaignExists(campaignId: string): Promise<void> {
  const campaign = await getCampaign(campaignId)
  if (!campaign) {
    throw new ImportCampaignNotFoundError(campaignId)
  }
}

export async function writeImportTempCsv(
  token: string,
  stream: ReadableStream,
): Promise<void> {
  const tempPath = storageAbs(importUploadTempRelPath(token))
  await mkdir(path.dirname(tempPath), { recursive: true })
  await pipeline(
    Readable.fromWeb(stream as NodeReadableStream),
    createWriteStream(tempPath),
  )
}

export async function readImportTempCsv(token: string): Promise<string> {
  const tempPath = storageAbs(importUploadTempRelPath(token))
  try {
    return await readFile(tempPath, "utf8")
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      throw new ImportTempNotFoundError(token)
    }
    throw error
  }
}

function parseExistsList(value: unknown): ExistsListEntry[] {
  if (!Array.isArray(value)) return []
  return value as ExistsListEntry[]
}

function parseRpcResult(value: Json): ImportCommitRpcResult {
  const record = value as ImportCommitRpcResult
  return {
    ...record,
    exists_list: parseExistsList(record.exists_list),
  }
}

type BatchMeta = {
  filename: string
  slug: string
  row_count: number
  rejected_rows: RejectedRow[]
  delimiter: string
  had_bom: boolean
}

async function callImportCommit(
  campaignId: string,
  batch: BatchMeta,
  rows: ParsedImportRow[],
  dryRun: boolean,
): Promise<ImportCommitRpcResult> {
  const { data, error } = await getSupabaseAdmin().rpc("import_commit", {
    p_campaign_id: campaignId,
    p_batch: {
      filename: batch.filename,
      slug: batch.slug,
      row_count: batch.row_count,
      rejected_rows: batch.rejected_rows,
      delimiter: batch.delimiter,
      had_bom: batch.had_bom,
    },
    p_rows: parsedRowsToRpc(rows),
    p_dry_run: dryRun,
  })

  if (error) {
    throw new Error(`import_commit failed: ${error.message}`)
  }

  if (data == null) {
    throw new Error("import_commit returned no data")
  }

  return parseRpcResult(data)
}

function buildCounts(
  rpc: ImportCommitRpcResult,
  rejectedCount: number,
): ImportCounts {
  return {
    imported: rpc.counts.imported,
    linked: rpc.counts.linked,
    duplicate: rpc.counts.duplicate,
    skipped: rpc.counts.skipped,
    rejected: rejectedCount,
  }
}

function assertCountsReconcile(rowCount: number, counts: ImportCounts): void {
  const total =
    counts.imported +
    counts.linked +
    counts.duplicate +
    counts.skipped +
    counts.rejected

  if (total !== rowCount) {
    throw new Error(
      `Import counts do not reconcile: ${total} !== ${rowCount} data rows`,
    )
  }
}

export async function previewImportFromText(
  campaignId: string,
  text: string,
  mapping?: PreviewResult["mapping"],
): Promise<Omit<PreviewResult, "token">> {
  await assertCampaignExists(campaignId)

  const parsed = parseImportCsv(text, mapping)
  const rpc = await callImportCommit(
    campaignId,
    {
      filename: "preview.csv",
      slug: "preview",
      row_count: parsed.rowCount,
      rejected_rows: parsed.rejectedRows,
      delimiter: parsed.delimiter,
      had_bom: parsed.hadBom,
    },
    parsed.rows,
    true,
  )

  const counts = buildCounts(rpc, parsed.rejectedRows.length)
  assertCountsReconcile(parsed.rowCount, counts)

  return {
    delimiter: parsed.delimiter,
    hadBom: parsed.hadBom,
    mapping: parsed.mapping,
    headers: parsed.headers,
    sampleRows: parsed.rows.slice(0, 5),
    counts,
    existsList: rpc.exists_list,
    rejectedRows: parsed.rejectedRows,
    rowCount: parsed.rowCount,
  }
}

export async function previewImportFromToken(
  campaignId: string,
  token: string,
  mapping: PreviewResult["mapping"],
): Promise<Omit<PreviewResult, "token">> {
  const text = await readImportTempCsv(token)
  return previewImportFromText(campaignId, text, mapping)
}

export async function createImportPreview(
  campaignId: string,
  file: File,
): Promise<PreviewResult> {
  await assertCampaignExists(campaignId)

  const token = randomUUID()
  await writeImportTempCsv(token, file.stream())

  const text = await readImportTempCsv(token)
  const preview = await previewImportFromText(campaignId, text)

  return { token, ...preview }
}

export async function commitImport(
  input: CommitImportInput,
): Promise<{ batchId: string; slug: string; counts: ImportCounts }> {
  await assertCampaignExists(input.campaignId)

  const text = await readImportTempCsv(input.token)
  const parsed = parseImportCsv(text, input.mapping)
  const baseSlug = slugFromName(path.basename(input.filename, path.extname(input.filename)))
  const slug = await resolveUniqueBatchSlug(baseSlug || "import")

  const rpc = await callImportCommit(
    input.campaignId,
    {
      filename: input.filename,
      slug,
      row_count: parsed.rowCount,
      rejected_rows: parsed.rejectedRows,
      delimiter: parsed.delimiter,
      had_bom: parsed.hadBom,
    },
    parsed.rows,
    false,
  )

  if (!rpc.batch_id) {
    throw new Error("import_commit did not return batch_id")
  }

  const counts = buildCounts(rpc, parsed.rejectedRows.length)

  const tempPath = storageAbs(importUploadTempRelPath(input.token))
  const auditPath = storageAbs(importBatchCsvRelPath(slug))
  try {
    await moveFile(tempPath, auditPath)
  } catch (error) {
    console.error("Failed to move import audit CSV after commit:", error)
    const { error: logError } = await getSupabaseAdmin().from("logs").insert({
      level: "error",
      scope: "importer",
      message: "Failed to move import audit CSV after commit",
      meta: {
        batchId: rpc.batch_id,
        slug,
        tempPath,
        auditPath,
        error: error instanceof Error ? error.message : String(error),
      },
    })
    if (logError) {
      console.error("Failed to write importer log:", logError.message)
    }
  }

  const createdIds = rpc.created_campaign_lead_ids ?? []
  if (createdIds.length > 0) {
    let enqueueFailures = 0
    for (const id of createdIds) {
      try {
        const landed = await enqueueLead(id)
        if (!landed) enqueueFailures++
      } catch (error) {
        enqueueFailures++
        console.error(`Failed to enqueue campaign lead ${id}:`, error)
      }
    }
    if (enqueueFailures > 0) {
      const { error: logError } = await getSupabaseAdmin().from("logs").insert({
        level: "error",
        scope: "importer",
        message: "Failed to enqueue one or more leads after import commit",
        meta: {
          batchId: rpc.batch_id,
          failedCount: enqueueFailures,
          totalCount: createdIds.length,
        },
      })
      if (logError) {
        console.error("Failed to write importer enqueue log:", logError.message)
      }
    }
  }

  return { batchId: rpc.batch_id, slug, counts }
}

export async function getImportBatch(
  id: string,
): Promise<ImportBatchWithCampaign | null> {
  const { data, error } = await getSupabaseAdmin()
    .from("import_batches")
    .select("*, campaign:campaigns(id, name)")
    .eq("id", id)
    .maybeSingle()

  if (error) {
    throw new Error(`Failed to fetch import batch: ${error.message}`)
  }

  if (!data) return null

  const { campaign, ...batch } = data as ImportBatchRow & {
    campaign: { id: string; name: string } | null
  }

  return {
    ...batch,
    campaign: campaign ?? { id: batch.campaign_id, name: "Unknown campaign" },
  }
}

export async function listImportBatches(limit = 20): Promise<ImportBatchWithCampaign[]> {
  const { data, error } = await getSupabaseAdmin()
    .from("import_batches")
    .select("*, campaign:campaigns(id, name)")
    .order("created_at", { ascending: false })
    .limit(limit)

  if (error) {
    throw new Error(`Failed to list import batches: ${error.message}`)
  }

  return (data ?? []).map((row) => {
    const { campaign, ...batch } = row as ImportBatchRow & {
      campaign: { id: string; name: string } | null
    }
    return {
      ...batch,
      campaign: campaign ?? { id: batch.campaign_id, name: "Unknown campaign" },
    }
  })
}

export function parseStoredExistsList(value: Json): ExistsListEntry[] {
  return parseExistsList(value)
}

export function parseStoredRejectedRows(value: Json): RejectedRow[] {
  if (!Array.isArray(value)) return []
  return value as RejectedRow[]
}
