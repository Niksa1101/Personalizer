import { Clapperboard } from "lucide-react"

import { EmptyState } from "@/components/empty-state"
import { IntroCard } from "@/components/intros/intro-card"
import { UploadCard } from "@/components/intros/upload-card"
import { listAssignableCampaigns, listIntrosWithUsage } from "@/lib/intros"

export const metadata = {
  title: "Intro Videos",
}

export default async function IntrosPage() {
  const [intros, assignableCampaigns] = await Promise.all([
    listIntrosWithUsage(),
    listAssignableCampaigns(),
  ])

  return (
    <div className="flex flex-1 flex-col gap-6 p-6">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">Intro Videos</h2>
        <p className="text-sm text-muted-foreground">
          Upload a pitch once — its duration becomes the master clock for every
          merged video in campaigns that use it.
        </p>
      </div>

      <UploadCard />

      {intros.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center py-12">
          <EmptyState
            icon={<Clapperboard />}
            title="No intro videos yet"
            description="Choose a video file above to upload your first intro. It will be normalized to 1080p before it appears here."
          />
        </div>
      ) : (
        <div className="grid gap-6 sm:grid-cols-2 xl:grid-cols-3">
          {intros.map((intro) => (
            <IntroCard
              key={intro.id}
              intro={intro}
              assignableCampaigns={assignableCampaigns}
            />
          ))}
        </div>
      )}
    </div>
  )
}
