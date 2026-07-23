import { LayoutDashboard } from "lucide-react"

import { EmptyState, PhaseAction } from "@/components/empty-state"

export const metadata = {
  title: "Dashboard",
}

export default async function DashboardPage() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center p-6">
      <EmptyState
        icon={<LayoutDashboard />}
        title="Create your first campaign"
        description="Campaigns organize intro videos, merge settings, and landing pages for each batch of leads."
        action={
          <PhaseAction label="Create campaign" phase={4} />
        }
      />
    </div>
  )
}
