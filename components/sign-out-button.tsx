"use client"

import { useRouter } from "next/navigation"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"

export function SignOutButton() {
  const router = useRouter()

  async function handleSignOut() {
    try {
      const response = await fetch("/api/logout", { method: "POST" })
      if (!response.ok) {
        toast.error("Could not sign out. Please try again.")
        return
      }
      toast.success("Signed out")
      router.push("/login")
      router.refresh()
    } catch {
      toast.error("Network error. Please try again.")
    }
  }

  return (
    <Button type="button" variant="outline" onClick={handleSignOut}>
      Sign out
    </Button>
  )
}
