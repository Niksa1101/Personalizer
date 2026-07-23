import { ScrollText } from "lucide-react"

import { EmptyState } from "@/components/empty-state"

export const metadata = {
  title: "Logs",
}

export default async function LogsPage() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center p-6">
      <EmptyState
        icon={<ScrollText />}
        title="No logs yet"
        description="System logs — stack traces, FFmpeg stderr, and deploy responses — will appear here as the pipeline runs."
      />
    </div>
  )
}
