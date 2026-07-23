import Link from "next/link"
import { FileSpreadsheet } from "lucide-react"

import { ImportWizard } from "@/components/import/import-wizard"
import { EmptyState } from "@/components/empty-state"
import { Badge } from "@/components/ui/badge"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { listCampaigns } from "@/lib/campaigns"
import { formatDateTime } from "@/lib/format"
import { listImportBatches } from "@/lib/imports"

export const metadata = {
  title: "Import",
}

export default async function ImportPage() {
  const [campaigns, batches] = await Promise.all([
    listCampaigns(),
    listImportBatches(),
  ])

  return (
    <div className="flex flex-1 flex-col gap-6 p-6">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">Import CSV</h2>
        <p className="text-sm text-muted-foreground">
          Pick a campaign, upload a Lead Finder export, preview the mapping, and
          commit — queued leads are ready for the worker.
        </p>
      </div>

      {campaigns.length === 0 ? (
        <EmptyState
          icon={<FileSpreadsheet />}
          title="Create a campaign first"
          description="Imports always land in one campaign. Create one on the Campaigns screen, then come back here."
        />
      ) : (
        <ImportWizard campaigns={campaigns} />
      )}

      {batches.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Recent imports</CardTitle>
            <CardDescription>
              Open a past report to review counts, cross-campaign links, and
              rejected rows.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>File</TableHead>
                  <TableHead>Campaign</TableHead>
                  <TableHead>When</TableHead>
                  <TableHead className="text-right">Rows</TableHead>
                  <TableHead className="text-right">Outcome</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {batches.map((batch) => (
                  <TableRow key={batch.id}>
                    <TableCell>
                      <Link
                        href={`/import/${batch.id}`}
                        className="font-medium underline-offset-4 hover:underline"
                      >
                        {batch.filename}
                      </Link>
                    </TableCell>
                    <TableCell>{batch.campaign.name}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatDateTime(batch.created_at)}
                    </TableCell>
                    <TableCell className="text-right">{batch.row_count}</TableCell>
                    <TableCell className="text-right">
                      <div className="flex flex-wrap justify-end gap-1">
                        {batch.imported_count > 0 ? (
                          <Badge variant="secondary">
                            {batch.imported_count} new
                          </Badge>
                        ) : null}
                        {batch.linked_count > 0 ? (
                          <Badge variant="outline">
                            {batch.linked_count} linked
                          </Badge>
                        ) : null}
                        {batch.duplicate_count > 0 ? (
                          <Badge variant="ghost">
                            {batch.duplicate_count} dup
                          </Badge>
                        ) : null}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ) : null}
    </div>
  )
}
