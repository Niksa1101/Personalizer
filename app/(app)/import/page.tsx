import { Upload } from "lucide-react"

import { EmptyState, PhaseAction } from "@/components/empty-state"

export const metadata = {
  title: "Import",
}

export default async function ImportPage() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center p-6">
      <EmptyState
        icon={<Upload />}
        title="Import a CSV"
        description="Pick a campaign, upload a Lead Finder export, preview the mapping, and commit — processing starts automatically."
        action={<PhaseAction label="Choose file" phase={6} />}
      />
    </div>
  )
}
