import { QueueView } from "@/components/queue/queue-view"
import { resolveSetting } from "@/lib/settings"

export const metadata = {
  title: "Queue",
}

export default async function QueuePage() {
  const storedConcurrency = await resolveSetting("queue.concurrency")

  return (
    <QueueView storedConcurrency={storedConcurrency} />
  )
}
