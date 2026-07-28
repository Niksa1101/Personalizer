"use client"

import Link from "next/link"
import { useMemo } from "react"
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
} from "@tanstack/react-table"
import { Copy, ExternalLink } from "lucide-react"
import { toast } from "sonner"

import {
  errorBucketLabel,
  leadDisplayName,
  statusBadgeVariant,
  statusLabel,
  stepLabel,
} from "@/components/leads/lead-labels"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { displayCurrentStep, type LeadSortColumn } from "@/lib/lead-filters"
import type { LeadListRow } from "@/lib/leads"
import { formatDateTime } from "@/lib/format"
import { cn } from "@/lib/utils"

type LeadsTableProps = {
  rows: LeadListRow[]
  staleIds: Set<string>
  selected: Set<string>
  onSelectedChange: (next: Set<string>) => void
  onRowClick: (id: string) => void
  onStaleClick: (id: string) => void
  sort: LeadSortColumn
  order: "asc" | "desc"
  pageHref: (overrides: {
    sort?: LeadSortColumn
    order?: "asc" | "desc"
  }) => string
}

function landingUrlCell(row: LeadListRow) {
  if (row.deployed_dry_run && !row.netlify_url) {
    return <Badge variant="secondary">Dry run</Badge>
  }
  if (row.landing_pages?.deploy_status === "removed") {
    return (
      <span className="text-muted-foreground line-through">
        Unpublished
      </span>
    )
  }
  if (row.netlify_url) {
    return (
      <div className="flex items-center gap-1">
        <a
          href={row.netlify_url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-primary hover:underline"
          onClick={(event) => event.stopPropagation()}
        >
          Open
          <ExternalLink className="size-3" />
        </a>
        <Button
          size="sm"
          variant="ghost"
          className="size-7 p-0"
          onClick={async (event) => {
            event.stopPropagation()
            await navigator.clipboard.writeText(row.netlify_url!)
            toast.success("Copied URL")
          }}
        >
          <Copy className="size-3.5" />
          <span className="sr-only">Copy landing URL</span>
        </Button>
      </div>
    )
  }
  return "—"
}

export function LeadsTable({
  rows,
  staleIds,
  selected,
  onSelectedChange,
  onRowClick,
  onStaleClick,
  sort,
  order,
  pageHref,
}: LeadsTableProps) {
  const allSelected = rows.length > 0 && rows.every((row) => selected.has(row.id))

  const columns = useMemo<ColumnDef<LeadListRow>[]>(
    () => [
      {
        id: "select",
        header: () => (
          <Checkbox
            checked={allSelected}
            onCheckedChange={(value) => {
              if (value) {
                onSelectedChange(new Set(rows.map((row) => row.id)))
              } else {
                onSelectedChange(new Set())
              }
            }}
            aria-label="Select all on page"
          />
        ),
        cell: ({ row }) => (
          <Checkbox
            checked={selected.has(row.original.id)}
            onCheckedChange={(value) => {
              const next = new Set(selected)
              if (value) next.add(row.original.id)
              else next.delete(row.original.id)
              onSelectedChange(next)
            }}
            onClick={(event) => event.stopPropagation()}
            aria-label={`Select ${row.original.leads.ref}`}
          />
        ),
      },
      {
        accessorKey: "ref",
        header: () => (
          <Link
            href={pageHref({
              sort: "ref",
              order: sort === "ref" && order === "asc" ? "desc" : "asc",
            })}
          >
            Ref
          </Link>
        ),
        cell: ({ row }) => {
          const stale = staleIds.has(row.original.id)
          return (
            <div className="flex items-center gap-2">
              <span>{row.original.leads.ref}</span>
              {stale ? (
                <Badge variant="secondary" className="text-xs">
                  Stale
                </Badge>
              ) : null}
            </div>
          )
        },
      },
      {
        id: "name",
        header: () => (
          <Link
            href={pageHref({
              sort: "company",
              order: sort === "company" && order === "asc" ? "desc" : "asc",
            })}
          >
            Name / Company
          </Link>
        ),
        cell: ({ row }) => leadDisplayName(row.original.leads),
      },
      {
        id: "website",
        header: () => (
          <Link
            href={pageHref({
              sort: "website",
              order: sort === "website" && order === "asc" ? "desc" : "asc",
            })}
          >
            Website
          </Link>
        ),
        cell: ({ row }) => row.original.leads.website_url ?? "—",
      },
      {
        id: "city",
        header: () => (
          <Link
            href={pageHref({
              sort: "city",
              order: sort === "city" && order === "asc" ? "desc" : "asc",
            })}
          >
            City
          </Link>
        ),
        cell: ({ row }) => row.original.leads.city ?? "—",
      },
      {
        id: "campaign",
        header: () => (
          <Link
            href={pageHref({
              sort: "campaign",
              order: sort === "campaign" && order === "asc" ? "desc" : "asc",
            })}
          >
            Campaign
          </Link>
        ),
        cell: ({ row }) => row.original.campaigns.name,
      },
      {
        accessorKey: "status",
        header: () => (
          <Link
            href={pageHref({
              sort: "status",
              order: sort === "status" && order === "asc" ? "desc" : "asc",
            })}
          >
            Status
          </Link>
        ),
        cell: ({ row }) => (
          <Badge variant={statusBadgeVariant(row.original.status)}>
            {statusLabel(row.original.status)}
          </Badge>
        ),
      },
      {
        accessorKey: "current_step",
        header: "Step",
        cell: ({ row }) =>
          stepLabel(
            displayCurrentStep(row.original.status, row.original.current_step),
          ),
      },
      {
        accessorKey: "error_bucket",
        header: "Bucket",
        cell: ({ row }) => errorBucketLabel(row.original.error_bucket),
      },
      {
        id: "landing_url",
        header: () => (
          <Link
            href={pageHref({
              sort: "landing_url",
              order: sort === "landing_url" && order === "asc" ? "desc" : "asc",
            })}
          >
            Landing URL
          </Link>
        ),
        cell: ({ row }) => landingUrlCell(row.original),
      },
      {
        accessorKey: "updated_at",
        header: () => (
          <Link
            href={pageHref({
              sort: "updated_at",
              order: sort === "updated_at" && order === "asc" ? "desc" : "asc",
            })}
          >
            Updated
          </Link>
        ),
        cell: ({ row }) => formatDateTime(row.original.updated_at),
      },
    ],
    [
      allSelected,
      onSelectedChange,
      order,
      pageHref,
      rows,
      selected,
      sort,
      staleIds,
    ],
  )

  const table = useReactTable({
    data: rows,
    columns,
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true,
    manualSorting: true,
    manualFiltering: true,
    getRowId: (row) => row.id,
  })

  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          {table.getHeaderGroups().map((headerGroup) => (
            <TableRow key={headerGroup.id}>
              {headerGroup.headers.map((header) => (
                <TableHead key={header.id}>
                  {header.isPlaceholder
                    ? null
                    : flexRender(
                        header.column.columnDef.header,
                        header.getContext(),
                      )}
                </TableHead>
              ))}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {table.getRowModel().rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={columns.length} className="h-24 text-center">
                No leads match these filters.
              </TableCell>
            </TableRow>
          ) : (
            table.getRowModel().rows.map((row) => {
              const stale = staleIds.has(row.original.id)
              return (
                <TableRow
                  key={row.id}
                  className={cn("cursor-pointer", stale && "bg-muted/40")}
                  onClick={(event) => {
                    // Base UI's Checkbox renders its hidden <input> as a
                    // *sibling* of the span and re-dispatches a fresh bubbling
                    // click on it (@base-ui/react CheckboxRoot: "Renders a
                    // <span> element and a hidden <input> beside"). The
                    // checkbox's own stopPropagation only stops the original
                    // event, so the row has to opt out by origin — otherwise
                    // ticking a row for a bulk action also opens its drawer.
                    if (
                      (event.target as HTMLElement).closest(
                        '[data-column="select"]',
                      )
                    ) {
                      return
                    }
                    if (stale) onStaleClick(row.original.id)
                    else onRowClick(row.original.id)
                  }}
                >
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id} data-column={cell.column.id}>
                      {flexRender(
                        cell.column.columnDef.cell,
                        cell.getContext(),
                      )}
                    </TableCell>
                  ))}
                </TableRow>
              )
            })
          )}
        </TableBody>
      </Table>
    </div>
  )
}
