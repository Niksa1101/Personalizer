"use client"

import { useState } from "react"
import { Download } from "lucide-react"
import { toast } from "sonner"

import { buildExportHref } from "@/lib/lead-filters"
import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"

type ExportButtonProps = {
  campaignId?: string
  campaignName?: string | null
  exportableCount: number
  excludedCount: number
}

export function ExportButton({
  campaignId,
  campaignName,
  exportableCount,
  excludedCount,
}: ExportButtonProps) {
  const [busy, setBusy] = useState(false)

  const href = buildExportHref(campaignId)

  const scopeLabel = campaignName
    ? `${exportableCount} ready lead${exportableCount === 1 ? "" : "s"} in ${campaignName}`
    : `${exportableCount} ready lead${exportableCount === 1 ? "" : "s"} (archived campaigns not included)`

  const disabledReason =
    exportableCount === 0
      ? excludedCount > 0
        ? `${excludedCount} ready lead(s) excluded — unpublished pages`
        : "No ready leads match export scope"
      : null

  const button = (
    <Button
      size="sm"
      variant="outline"
      disabled={busy || exportableCount === 0}
      onClick={async () => {
        setBusy(true)
        try {
          const res = await fetch(href)
          if (!res.ok) {
            let detail = ""
            try {
              detail = ((await res.json()) as { error?: string }).error ?? ""
            } catch {
              detail = ""
            }
            toast.error(
              res.status === 401
                ? "Session expired — sign in again"
                : detail || `Export failed (${res.status})`,
            )
            return
          }

          const rowCount = Number(res.headers.get("X-Export-Row-Count") ?? "0")
          const skipped = Number(res.headers.get("X-Export-Skipped") ?? "0")
          const missingVideo = Number(
            res.headers.get("X-Export-Missing-Video") ?? "0",
          )

          const disposition = res.headers.get("Content-Disposition")
          const filenameMatch = disposition?.match(/filename="([^"]+)"/)
          const downloadName = filenameMatch?.[1] ?? "personalizer-export.csv"

          const blob = await res.blob()
          const url = URL.createObjectURL(blob)
          const a = Object.assign(document.createElement("a"), {
            href: url,
            download: downloadName,
          })
          document.body.appendChild(a)
          a.click()
          a.remove()
          setTimeout(() => URL.revokeObjectURL(url), 1000)

          if (rowCount === 0) {
            toast.message("No rows match export filters")
          } else {
            let description = `Exported ${rowCount} row${rowCount === 1 ? "" : "s"}`
            if (skipped > 0) {
              description += `. ${skipped} excluded (unpublished pages)`
            }
            if (missingVideo > 0) {
              description += `. ${missingVideo} missing video URL`
            }
            toast.success("Export downloaded", { description })
          }
        } catch (error) {
          toast.error(
            error instanceof Error ? error.message : "Export failed",
          )
        } finally {
          setBusy(false)
        }
      }}
    >
      <Download className="size-4" />
      Export {scopeLabel} — other filters not applied
    </Button>
  )

  if (disabledReason) {
    return (
      <Tooltip>
        <TooltipTrigger render={button} />
        <TooltipContent>{disabledReason}</TooltipContent>
      </Tooltip>
    )
  }

  return button
}
