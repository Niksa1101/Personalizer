"use client"

import { useRouter } from "next/navigation"
import { useState } from "react"
import { toast } from "sonner"

import {
  archiveCampaignAction,
  unarchiveCampaignAction,
} from "@/app/(app)/campaigns/actions"

type ArchivableCampaign = {
  id: string
  archived_at: string | null
}

export function useArchiveToggle(campaign: ArchivableCampaign) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)

  async function toggle() {
    setBusy(true)
    try {
      if (campaign.archived_at) {
        await unarchiveCampaignAction(campaign.id)
        toast.success("Campaign unarchived")
      } else {
        await archiveCampaignAction(campaign.id)
        toast.success("Campaign archived")
      }
      router.refresh()
    } catch {
      toast.error("Could not update campaign")
    } finally {
      setBusy(false)
    }
  }

  return { busy, toggle }
}
