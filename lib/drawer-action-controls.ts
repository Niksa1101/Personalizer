import type { LeadStatus } from "@/lib/campaign-types"

/**
 * What a drawer action control needs to render itself.
 *
 * Lives here rather than beside `ACTION_CONTROLS` so the pure side of the app
 * can name the shape without importing a client component. D67's exhaustiveness
 * guarantee comes from `ACTION_CONTROLS` being typed
 * `Record<DrawerActionId, …>` — a missing id is a `tsc` error, which is what
 * the decision asked for. No runtime mirror of the id list belongs here: it
 * would add a second thing to keep in sync without adding any check.
 */
export type DrawerActionContext = {
  campaignLeadId: string
  status: LeadStatus
  websiteUrl: string | null
  conflictRef?: string
  onDeleteDuplicate?: () => void
}
