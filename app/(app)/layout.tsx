import { redirect } from "next/navigation"

import { UnauthorizedError, verifySession } from "@/lib/dal"

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode
}) {
  try {
    await verifySession()
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      redirect("/login")
    }
    throw error
  }

  return <div className="flex flex-1 flex-col">{children}</div>
}
