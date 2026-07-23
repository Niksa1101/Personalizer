import Link from "next/link"

import { EmptyState } from "@/components/empty-state"
import { Button } from "@/components/ui/button"

export const metadata = {
  title: "Not found",
}

export default function NotFound() {
  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-4 p-6">
      <EmptyState
        icon={<span className="text-lg font-semibold">404</span>}
        title="Page not found"
        description="This page does not exist."
        action={
          <Button render={<Link href="/" />}>Back to dashboard</Button>
        }
      />
    </div>
  )
}
