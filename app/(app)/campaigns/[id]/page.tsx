import { Megaphone } from "lucide-react"

import { EmptyState } from "@/components/empty-state"

export const metadata = {
  title: "Campaign",
}

type CampaignDetailPageProps = {
  params: Promise<{ id: string }>
}

export default async function CampaignDetailPage({
  params,
}: CampaignDetailPageProps) {
  const { id } = await params

  return (
    <div className="flex flex-1 flex-col items-center justify-center p-6">
      <EmptyState
        icon={<Megaphone />}
        title="Campaign detail — coming in Phase 4"
        description={`Campaign ${id} settings, intro assignment, and lead counts will be editable here.`}
      />
    </div>
  )
}
