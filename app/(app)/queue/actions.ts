"use server"

import { revalidatePath } from "next/cache"

import { verifySession } from "@/lib/dal"
import { clearQueue } from "@/lib/queue-clear"
import { getQueue } from "@/lib/queue"
import { upsertSettings } from "@/lib/settings-admin"
import { settingSchemaFor } from "@/lib/settings-schema"

export type QueueActionState = {
  error?: string
  saved?: boolean
  removedCount?: number
  removeFailedCount?: number
  pausedLeadCount?: number
}

export async function pausePipelineAction(): Promise<QueueActionState> {
  await verifySession()
  try {
    await getQueue().pause()
    revalidatePath("/queue")
    return { saved: true }
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Failed to pause queue",
    }
  }
}

export async function resumePipelineAction(): Promise<QueueActionState> {
  await verifySession()
  try {
    await getQueue().resume()
    revalidatePath("/queue")
    return { saved: true }
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Failed to resume queue",
    }
  }
}

export async function clearQueueAction(): Promise<QueueActionState> {
  await verifySession()
  try {
    const result = await clearQueue()
    revalidatePath("/queue")
    revalidatePath("/leads")
    return {
      saved: true,
      removedCount: result.removedCount,
      removeFailedCount: result.removeFailedCount,
      pausedLeadCount: result.pausedLeadCount,
    }
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Failed to clear queue",
    }
  }
}

export async function updateConcurrencyAction(
  raw: FormData | string,
): Promise<QueueActionState> {
  await verifySession()

  const value = typeof raw === "string" ? raw : raw.get("queue.concurrency")
  const parsed = settingSchemaFor("queue.concurrency").safeParse(value)
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid concurrency" }
  }

  try {
    await upsertSettings([{ key: "queue.concurrency", value: parsed.data }])
    revalidatePath("/queue")
    revalidatePath("/settings")
    return { saved: true }
  } catch (error) {
    return {
      error:
        error instanceof Error ? error.message : "Failed to update concurrency",
    }
  }
}
