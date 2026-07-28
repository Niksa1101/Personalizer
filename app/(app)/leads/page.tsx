import { LeadsView } from "@/components/leads/leads-view"
import { parseLeadFilters, serializeLeadFilters } from "@/lib/lead-filters"
import { listCampaignOptions, listLeads } from "@/lib/leads"
import { getSupabaseAdmin } from "@/lib/supabase"

export const metadata = {
  title: "Leads",
}

type LeadsPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

async function listBatchOptions(campaignId?: string) {
  if (!campaignId) return []

  const { data, error } = await getSupabaseAdmin()
    .from("import_batches")
    .select("id, created_at, imported_count, linked_count")
    .eq("campaign_id", campaignId)
    .order("created_at", { ascending: false })

  if (error) throw new Error(`Failed to list batches: ${error.message}`)

  return (data ?? []).map((batch) => ({
    id: batch.id,
    label: new Date(batch.created_at).toLocaleString(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }),
  }))
}

export default async function LeadsPage({ searchParams }: LeadsPageProps) {
  const params = await searchParams
  const filters = parseLeadFilters(params)

  const [result, campaigns, batches] = await Promise.all([
    listLeads(filters),
    listCampaignOptions(),
    listBatchOptions(filters.campaignId),
  ])

  return (
    <LeadsView
      key={serializeLeadFilters(filters).toString()}
      initialResult={result}
      campaigns={campaigns}
      filters={filters}
      batches={batches}
    />
  )
}
