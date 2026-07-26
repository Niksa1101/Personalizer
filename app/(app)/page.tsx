import { DashboardView } from "@/components/dashboard/dashboard-view"
import { listCampaigns } from "@/lib/campaigns"
import {
  getDashboardSnapshot,
  parseDashboardScope,
  scopeKey,
} from "@/lib/dashboard"

export const metadata = {
  title: "Dashboard",
}

type DashboardPageProps = {
  searchParams: Promise<{
    campaign?: string | string[]
    archived?: string | string[]
  }>
}

function firstParam(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0]
  return value
}

export default async function DashboardPage({ searchParams }: DashboardPageProps) {
  const params = await searchParams
  const scopeResult = parseDashboardScope(
    firstParam(params.campaign),
    firstParam(params.archived),
  )

  const scope =
    "error" in scopeResult
      ? { campaignId: null, includeArchived: false }
      : scopeResult

  const [snapshot, campaigns] = await Promise.all([
    getDashboardSnapshot(scope),
    listCampaigns({ includeArchived: scope.includeArchived }),
  ])

  return (
    <DashboardView
      key={scopeKey(scope)}
      initialSnapshot={snapshot}
      campaigns={campaigns}
      scope={scope}
    />
  )
}
