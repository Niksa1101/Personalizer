"use client"

import { useState } from "react"

import { Button } from "@/components/ui/button"
import {
  Field,
  FieldDescription,
  FieldLabel,
} from "@/components/ui/field"
import { cn } from "@/lib/utils"

type ViewportWidth = 375 | 1920

type LandingPageViewerProps = {
  campaignLeadId: string
  path: string
}

export function LandingPageViewer({
  campaignLeadId,
  path,
}: LandingPageViewerProps) {
  const [width, setWidth] = useState<ViewportWidth>(375)
  const previewSrc = `/api/landing/${campaignLeadId}/preview`

  return (
    <div className="space-y-4">
      <Field>
        <FieldLabel>Stored landing page</FieldLabel>
        <FieldDescription>
          Sandboxed preview of the generated HTML at{" "}
          <span className="font-mono">{path}</span>. External requests go to
          Supabase for video and poster only.
        </FieldDescription>
      </Field>

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant={width === 375 ? "default" : "outline"}
          size="sm"
          onClick={() => setWidth(375)}
        >
          375px
        </Button>
        <Button
          type="button"
          variant={width === 1920 ? "default" : "outline"}
          size="sm"
          onClick={() => setWidth(1920)}
        >
          1920px
        </Button>
      </div>

      <div className="overflow-x-auto rounded-xl border border-border bg-muted/20 p-4">
        <div
          className={cn("mx-auto transition-[width] duration-200")}
          style={{ width: `${width}px`, maxWidth: "100%" }}
        >
          <iframe
            title="Landing page preview"
            sandbox=""
            src={previewSrc}
            className="h-[min(80vh,900px)] w-full rounded-lg border border-border bg-background"
          />
        </div>
      </div>
    </div>
  )
}
