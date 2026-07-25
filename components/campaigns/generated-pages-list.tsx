import Link from "next/link"

import { Button } from "@/components/ui/button"
import {
  Field,
  FieldDescription,
  FieldLabel,
} from "@/components/ui/field"
import type { GeneratedPageListItem } from "@/lib/campaigns"

type GeneratedPagesListProps = {
  campaignId: string
  pages: GeneratedPageListItem[]
  totalCount: number
}

function formatLeadLabel(page: GeneratedPageListItem): string {
  if (page.leadName) {
    return `${page.leadRef} — ${page.leadName}`
  }
  return page.leadRef
}

export function GeneratedPagesList({
  campaignId,
  pages,
  totalCount,
}: GeneratedPagesListProps) {
  if (totalCount === 0) {
    return (
      <Field>
        <FieldLabel>Generated pages</FieldLabel>
        <FieldDescription>
          No landing pages yet. Run the page pipeline step on a lead to generate
          one.
        </FieldDescription>
      </Field>
    )
  }

  const remaining = totalCount - pages.length

  return (
    <Field>
      <FieldLabel>Generated pages</FieldLabel>
      <FieldDescription>
        {totalCount} page{totalCount === 1 ? "" : "s"} generated
        {remaining > 0 ? ` — showing ${pages.length} most recent` : ""}.
      </FieldDescription>
      <ul className="divide-y divide-border rounded-xl border border-border">
        {pages.map((page) => (
          <li
            key={page.campaignLeadId}
            className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
          >
            <div className="min-w-0 space-y-0.5">
              <p className="truncate text-sm font-medium">
                {formatLeadLabel(page)}
              </p>
              <p className="truncate font-mono text-xs text-muted-foreground">
                {page.path}
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              render={
                <Link
                  href={`/campaigns/${campaignId}/landing/${page.campaignLeadId}`}
                />
              }
            >
              Preview
            </Button>
          </li>
        ))}
      </ul>
    </Field>
  )
}
