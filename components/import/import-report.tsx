import Link from "next/link"

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
import { formatDateTime } from "@/lib/format"
import type {
  ExistsListEntry,
  ImportCounts,
  ParsedImportRow,
  RejectedRow,
} from "@/lib/import-types"

type ImportReportProps = {
  filename: string
  campaignName: string
  createdAt: string
  delimiter: string | null
  hadBom: boolean
  rowCount: number
  counts: ImportCounts
  existsList: ExistsListEntry[]
  rejectedRows: RejectedRow[]
  sampleRows?: ParsedImportRow[]
}

function delimiterLabel(value: string | null): string {
  if (value === "\t") return "tab"
  if (value === ";") return "semicolon"
  if (value === ",") return "comma"
  return value ?? "unknown"
}

export function ImportReport({
  filename,
  campaignName,
  createdAt,
  delimiter,
  hadBom,
  rowCount,
  counts,
  existsList,
  rejectedRows,
  sampleRows,
}: ImportReportProps) {
  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Summary</CardTitle>
          <CardDescription>
            {filename} → {campaignName} · {formatDateTime(createdAt)}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-2">
            <Badge variant="secondary">{counts.imported} imported</Badge>
            <Badge variant="outline">{counts.linked} linked</Badge>
            <Badge variant="ghost">{counts.duplicate} duplicates</Badge>
            <Badge variant="ghost">{counts.skipped} skipped</Badge>
            <Badge variant={counts.rejected > 0 ? "destructive" : "ghost"}>
              {counts.rejected} rejected
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            {rowCount} data rows · delimiter: {delimiterLabel(delimiter)}
            {hadBom ? " · UTF-8 BOM stripped" : ""}
          </p>
        </CardContent>
      </Card>

      {existsList.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Already in other campaigns</CardTitle>
            <CardDescription>
              These leads were linked into {campaignName} using existing records
              and recordings.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Lead</TableHead>
                  <TableHead>Domain / email</TableHead>
                  <TableHead>Campaigns</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {existsList.map((entry, index) => (
                  <TableRow key={`${entry.domain ?? entry.email ?? index}`}>
                    <TableCell>{entry.company ?? "—"}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {entry.domain ?? entry.email ?? "—"}
                    </TableCell>
                    <TableCell>
                      {entry.campaigns.map((campaign) => (
                        <Link
                          key={campaign.id}
                          href={`/campaigns/${campaign.id}`}
                          className="mr-2 underline-offset-4 hover:underline"
                        >
                          {campaign.name}
                        </Link>
                      ))}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ) : null}

      {rejectedRows.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Rejected rows</CardTitle>
            <CardDescription>
              Line numbers match a text editor (header is line 1).
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-20">Line</TableHead>
                  <TableHead>Reason</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rejectedRows.map((row) => (
                  <TableRow key={`${row.row}-${row.reason}`}>
                    <TableCell>{row.row}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {row.reason}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ) : null}

      {sampleRows && sampleRows.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Sample rows</CardTitle>
            <CardDescription>First rows as stored after mapping.</CardDescription>
          </CardHeader>
          <CardContent>
            <SampleRowsTable rows={sampleRows} />
          </CardContent>
        </Card>
      ) : null}
    </div>
  )
}

function SampleRowsTable({ rows }: { rows: ParsedImportRow[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Company</TableHead>
          <TableHead>Website</TableHead>
          <TableHead>Email</TableHead>
          <TableHead>Status</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row, index) => (
          <TableRow key={index}>
            <TableCell>{row.company ?? "—"}</TableCell>
            <TableCell className="max-w-xs truncate text-muted-foreground">
              {row.website_url ?? "—"}
            </TableCell>
            <TableCell className="text-muted-foreground">
              {row.email ?? "—"}
            </TableCell>
            <TableCell>
              {row.skip ? (
                <Badge variant="outline">skipped</Badge>
              ) : (
                <Badge variant="secondary">ok</Badge>
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}
