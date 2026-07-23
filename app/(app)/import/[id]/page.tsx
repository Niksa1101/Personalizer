import Link from "next/link"

import { ImportReport } from "@/components/import/import-report"
import { formatDateTime } from "@/lib/format"
import {
  getImportBatch,
  parseStoredExistsList,
  parseStoredRejectedRows,
} from "@/lib/imports"

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const batch = await getImportBatch(id)
  return {
    title: batch ? `Import — ${batch.filename}` : "Import report",
  }
}

export default async function ImportReportPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const batch = await getImportBatch(id)

  if (!batch) {
    return (
      <div className="flex flex-1 flex-col gap-4 p-6">
        <h2 className="text-lg font-semibold tracking-tight">Import not found</h2>
        <p className="text-sm text-muted-foreground">
          This import batch may have been deleted or the link is wrong.
        </p>
        <Link href="/import" className="text-sm text-primary underline-offset-4 hover:underline">
          Back to Import
        </Link>
      </div>
    )
  }

  return (
    <div className="flex flex-1 flex-col gap-6 p-6">
      <div>
        <Link
          href="/import"
          className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          ← Import
        </Link>
        <h2 className="mt-2 text-lg font-semibold tracking-tight">
          {batch.filename}
        </h2>
        <p className="text-sm text-muted-foreground">
          {batch.campaign.name} · {formatDateTime(batch.created_at)}
        </p>
      </div>

      <ImportReport
        filename={batch.filename}
        campaignName={batch.campaign.name}
        createdAt={batch.created_at}
        delimiter={batch.delimiter}
        hadBom={batch.had_bom}
        rowCount={batch.row_count}
        counts={{
          imported: batch.imported_count,
          linked: batch.linked_count,
          duplicate: batch.duplicate_count,
          skipped: batch.skipped_count,
          rejected: parseStoredRejectedRows(batch.rejected_rows).length,
        }}
        existsList={parseStoredExistsList(batch.exists_list)}
        rejectedRows={parseStoredRejectedRows(batch.rejected_rows)}
      />
    </div>
  )
}
