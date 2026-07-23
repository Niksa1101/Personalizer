import Link from "next/link"

import { EmptyState } from "@/components/empty-state"
import { Button } from "@/components/ui/button"

export const metadata = {
  title: "Not found",
}

export default function AppNotFound() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 p-6">
      <EmptyState
        icon={<span className="text-lg font-semibold">404</span>}
        title="Page not found"
        description="This screen does not exist. Use the sidebar to navigate to a valid page."
        action={
          <Button render={<Link href="/" />}>Back to dashboard</Button>
        }
      />
    </div>
  )
}
