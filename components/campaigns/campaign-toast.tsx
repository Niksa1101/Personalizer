"use client"

import { useEffect } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { toast } from "sonner"

const TOAST_MESSAGES: Record<string, { message: string; type: "success" | "info" }> = {
  created: { message: "Campaign created", type: "success" },
  deleted: {
    message:
      "Campaign deleted. Removal queued — published pages update on the next sync.",
    type: "success",
  },
}

export function CampaignToastHandler() {
  const searchParams = useSearchParams()
  const pathname = usePathname()
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
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false })
  }, [pathname, router, searchParams])

  return null
}
