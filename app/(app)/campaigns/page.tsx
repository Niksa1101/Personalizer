import { Megaphone } from "lucide-react"

import { EmptyState, PhaseAction } from "@/components/empty-state"

export const metadata = {
  title: "Campaigns",
}

export default async function CampaignsPage() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center p-6">
      <EmptyState
        icon={<Megaphone />}
        title="Create your first campaign"
        description="A campaign holds one intro video, merge settings, a landing template, and a CTA for a batch of leads."
        action={<PhaseAction label="Create campaign" phase={4} />}
      />
    </div>
  )
}
