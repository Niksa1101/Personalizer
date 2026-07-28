import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination"

type LeadPaginationProps = {
  page: number
  pageCount: number
  total: number
  hrefForPage: (page: number) => string
}

function pageNumbers(current: number, total: number): Array<number | "ellipsis"> {
  if (total <= 7) {
    return Array.from({ length: total }, (_, index) => index + 1)
  }

  const pages: Array<number | "ellipsis"> = [1]

  if (current > 3) pages.push("ellipsis")

  const start = Math.max(2, current - 1)
  const end = Math.min(total - 1, current + 1)
  for (let page = start; page <= end; page += 1) {
    pages.push(page)
  }

  if (current < total - 2) pages.push("ellipsis")
  pages.push(total)

  return pages
}

export function LeadPagination({
  page,
  pageCount,
  total,
  hrefForPage,
}: LeadPaginationProps) {
  if (pageCount <= 1) return null

  const pages = pageNumbers(page, pageCount)

  return (
    <div className="flex items-center justify-between gap-4 text-sm text-muted-foreground">
      <span>
        Page {page} of {pageCount} ({total.toLocaleString()} total)
      </span>
      <Pagination>
        <PaginationContent>
          <PaginationItem>
            <PaginationPrevious
              href={page > 1 ? hrefForPage(page - 1) : undefined}
              aria-disabled={page <= 1}
            />
          </PaginationItem>
          {pages.map((entry, index) =>
            entry === "ellipsis" ? (
              <PaginationItem key={`ellipsis-${index}`}>
                <PaginationEllipsis />
              </PaginationItem>
            ) : (
              <PaginationItem key={entry}>
                <PaginationLink href={hrefForPage(entry)} isActive={entry === page}>
                  {entry}
                </PaginationLink>
              </PaginationItem>
            ),
          )}
          <PaginationItem>
            <PaginationNext
              href={page < pageCount ? hrefForPage(page + 1) : undefined}
              aria-disabled={page >= pageCount}
            />
          </PaginationItem>
        </PaginationContent>
      </Pagination>
    </div>
  )
}
