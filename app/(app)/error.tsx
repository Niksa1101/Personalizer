"use client"

import { useEffect } from "react"

import { Button } from "@/components/ui/button"

export const ERROR_BOUNDARY_MARKER = "pz-app-error-boundary"

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error(error)
  }, [error])

  return (
    <div
      data-error-boundary={ERROR_BOUNDARY_MARKER}
      className="flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center"
    >
      <h2 className="text-lg font-semibold">Something went wrong</h2>
      <p className="max-w-md text-sm text-muted-foreground">
        An unexpected error occurred. You can try again, or sign out and return
        later.
      </p>
      <Button type="button" onClick={reset}>
        Try again
      </Button>
    </div>
  )
}
