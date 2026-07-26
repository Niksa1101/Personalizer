import Link from "next/link"
import { Users } from "lucide-react"

import { Button } from "@/components/ui/button"
import { EmptyState } from "@/components/empty-state"
import { LEAD_STATUSES } from "@/lib/campaign-types"
import { ERROR_BUCKETS } from "@/lib/pipeline-types"

export const metadata = {
  title: "Leads",
}

type LeadsPageProps = {
  searchParams: Promise<{
    campaign?: string | string[]
    status?: string | string[]
    bucket?: string | string[]
    archived?: string | string[]
  }>
}

const VALID_STATUSES = new Set<string>(LEAD_STATUSES)
const VALID_BUCKETS = new Set<string>(ERROR_BUCKETS)

function firstParam(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0]
  return value
}

export default async function LeadsPage({ searchParams }: LeadsPageProps) {
  const params = await searchParams
  const filters: string[] = []

  const campaign = firstParam(params.campaign)
  const status = firstParam(params.status)
  const bucket = firstParam(params.bucket)
  const archived = firstParam(params.archived)

  if (campaign) filters.push(`campaign=${campaign}`)
  if (status && VALID_STATUSES.has(status)) {
    filters.push(`status=${status}`)
  } else if (status) {
    filters.push(`status=${status} (invalid)`)
  }
  if (bucket && VALID_BUCKETS.has(bucket)) {
    filters.push(`bucket=${bucket}`)
  } else if (bucket) {
    filters.push(`bucket=${bucket} (invalid)`)
  }
  if (archived === "1") filters.push("archived=1")

  return (
    <div className="flex flex-1 flex-col items-center justify-center p-6">
      <EmptyState
        icon={<Users />}
        title="No leads yet"
        description={
          filters.length > 0
            ? `Leads table arrives in Phase 13. Active filters: ${filters.join(", ")}.`
            : "Leads appear here after you import a CSV and assign them to a campaign."
        }
        action={
          <Button render={<Link href="/import" />}>Import CSV</Button>
        }
      />
    </div>
  )
}
