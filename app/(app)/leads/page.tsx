import Link from "next/link"
import { Users } from "lucide-react"

import { Button } from "@/components/ui/button"
import { EmptyState } from "@/components/empty-state"

export const metadata = {
  title: "Leads",
}

export default async function LeadsPage() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center p-6">
      <EmptyState
        icon={<Users />}
        title="No leads yet"
        description="Leads appear here after you import a CSV and assign them to a campaign."
        action={
          <Button render={<Link href="/import" />}>Import CSV</Button>
        }
      />
    </div>
  )
}
