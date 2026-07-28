import type { ErrorBucket } from "@/lib/pipeline-types"
import type { LeadStatus, MergeLayout } from "@/lib/campaign-types"
import type { PipelineStep } from "@/lib/pipeline-types"
import { bucketLabel } from "@/lib/error-copy"

export function leadDisplayName(input: {
  company: string | null
  full_name: string | null
  first_name: string | null
  last_name: string | null
}): string {
  if (input.company?.trim()) return input.company.trim()
  if (input.full_name?.trim()) return input.full_name.trim()
  const parts = [input.first_name, input.last_name].filter(Boolean)
  if (parts.length > 0) return parts.join(" ")
  return "—"
}

export function statusLabel(status: LeadStatus): string {
  switch (status) {
    case "queued":
      return "Queued"
    case "processing":
      return "Processing"
    case "paused":
      return "Paused"
    case "deployed":
      return "Deployed"
    case "ready":
      return "Ready"
    case "failed":
      return "Failed"
    case "skipped":
      return "Skipped"
    default:
      return status
  }
}

export function statusBadgeVariant(
  status: LeadStatus,
): "default" | "secondary" | "destructive" | "outline" {
  switch (status) {
    case "failed":
      return "destructive"
    case "processing":
    case "deployed":
    case "ready":
      return "default"
    case "paused":
      return "secondary"
    default:
      return "outline"
  }
}

export function stepLabel(step: PipelineStep | null): string {
  if (!step) return "—"
  switch (step) {
    case "recording":
      return "Recording"
    case "merge":
      return "Merge"
    case "page":
      return "Page"
    case "deploy":
      return "Deploy"
    default:
      return step
  }
}

export function errorBucketLabel(bucket: ErrorBucket | null): string {
  if (!bucket) return "—"
  return bucketLabel(bucket)
}

export function mergeLayoutLabel(layout: MergeLayout | null): string {
  if (!layout) return "Campaign default"
  return layout.replace(/_/g, " ")
}
