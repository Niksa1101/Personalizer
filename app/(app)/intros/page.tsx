import { Clapperboard } from "lucide-react"

import { EmptyState, PhaseAction } from "@/components/empty-state"

export const metadata = {
  title: "Intro Videos",
}

export default async function IntrosPage() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center p-6">
      <EmptyState
        icon={<Clapperboard />}
        title="No intro videos yet"
        description="Upload a pitch video once — its duration becomes the master clock for every merged video in campaigns that use it."
        action={<PhaseAction label="Upload intro" phase={5} />}
      />
    </div>
  )
}
