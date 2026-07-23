import { ListChecks } from "lucide-react"

import { EmptyState } from "@/components/empty-state"

export const metadata = {
  title: "Queue",
}

export default async function QueuePage() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center p-6">
      <EmptyState
        icon={<ListChecks />}
        title="No jobs in the queue"
        description="Active and queued pipeline jobs will appear here once leads are processing."
      />
    </div>
  )
}
