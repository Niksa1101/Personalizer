import { Settings } from "lucide-react"

import { EmptyState } from "@/components/empty-state"

export const metadata = {
  title: "Settings",
}

export default async function SettingsPage() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center p-6">
      <EmptyState
        icon={<Settings />}
        title="Global defaults"
        description="Recorder, merge, encode, queue, and deploy settings — plus environment health — will be editable here in a later phase."
      />
    </div>
  )
}
