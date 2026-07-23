"use client"

import { useEffect } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { toast } from "sonner"

const TOAST_MESSAGES: Record<string, { message: string; type: "success" | "info" }> = {
  created: { message: "Campaign created", type: "success" },
  deleted: { message: "Campaign deleted", type: "success" },
  archived: { message: "Campaign archived", type: "success" },
  unarchived: { message: "Campaign unarchived", type: "success" },
  saved: { message: "Changes saved", type: "success" },
}

export function CampaignToastHandler() {
  const searchParams = useSearchParams()
  const router = useRouter()

  useEffect(() => {
    const toastKey = searchParams.get("toast")
    if (!toastKey) return

    const config = TOAST_MESSAGES[toastKey]
    if (config) {
      if (config.type === "success") toast.success(config.message)
      else toast.info(config.message)
    }

    const next = new URLSearchParams(searchParams.toString())
    next.delete("toast")
    const query = next.toString()
    router.replace(query ? `?${query}` : ".", { scroll: false })
  }, [router, searchParams])

  return null
}
