import type { LeadStatusCounts } from "@/lib/campaign-types"
import { LEAD_STATUSES } from "@/lib/campaign-types"

const STATUS_LABELS: Record<(typeof LEAD_STATUSES)[number], string> = {
  queued: "Queued",
  processing: "Processing",
  paused: "Paused",
  deployed: "Deployed",
  ready: "Ready",
  failed: "Failed",
  skipped: "Skipped",
}

export function formatLeadStatusCounts(counts: LeadStatusCounts): string {
  const parts = LEAD_STATUSES.filter((status) => counts[status] > 0).map(
    (status) => `${counts[status]} ${STATUS_LABELS[status].toLowerCase()}`,
  )
  return parts.length > 0 ? parts.join(", ") : "No leads"
}

export function formatDate(iso: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
  }).format(new Date(iso))
}

export const MERGE_LAYOUT_LABELS = {
  bubble_br: "Bubble — bottom right",
  bubble_bl: "Bubble — bottom left",
  bubble_tr: "Bubble — top right",
  bubble_tl: "Bubble — top left",
  rect_br: "Rectangle — bottom right",
  fullscreen_intro: "Fullscreen intro → recording",
} as const

export const CTA_TYPE_LABELS = {
  calendar: "Calendar link",
  website: "Website",
  email: "Email",
  phone: "Phone",
  custom: "Custom",
} as const
