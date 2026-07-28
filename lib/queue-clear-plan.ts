import type { Job } from "bullmq"

export type ClearQueuePlan = {
  leadIds: string[]
  removeFailedCount: number
}

export async function planClearQueue(jobs: Job[]): Promise<ClearQueuePlan> {
  const leadIds: string[] = []
  let removeFailedCount = 0

  for (const job of jobs) {
    const leadId = job.data?.campaignLeadId ?? job.id
    if (!leadId) continue

    try {
      await job.remove()
      leadIds.push(String(leadId))
    } catch {
      removeFailedCount += 1
    }
  }

  return { leadIds, removeFailedCount }
}
