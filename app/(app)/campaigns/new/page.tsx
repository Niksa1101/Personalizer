import { CreateCampaignForm } from "@/components/campaigns/create-campaign-form"

export const metadata = {
  title: "New campaign",
}

export default function NewCampaignPage() {
  return (
    <div className="flex flex-1 flex-col gap-6 p-6">
      <div className="mx-auto w-full max-w-lg space-y-2">
        <h2 className="text-lg font-semibold tracking-tight">New campaign</h2>
        <p className="text-sm text-muted-foreground">
          Name your campaign and confirm the URL slug. You can configure everything
          else on the settings page.
        </p>
      </div>
      <CreateCampaignForm />
    </div>
  )
}
