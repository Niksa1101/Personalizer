import { headers } from "next/headers"
import { redirect } from "next/navigation"

import { AppSidebar } from "@/components/app-sidebar"
import { SiteHeader } from "@/components/site-header"
import { SystemBanner } from "@/components/system-banner"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import { UnauthorizedError, verifySession } from "@/lib/dal"
import { loginUrlFor } from "@/lib/next-path"

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode
}) {
  try {
    await verifySession()
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      // Reached only when a cookie was PRESENT but did not verify — the proxy
      // already redirected the no-cookie case. `x-pathname` is set by proxy.ts
      // because a layout receives no pathname of its own; without it this
      // redirect would drop the destination the proxy takes care to preserve.
      const requestHeaders = await headers()
      redirect(loginUrlFor(requestHeaders.get("x-pathname")))
    }
    throw error
  }

  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>
        <SystemBanner />
        <SiteHeader />
        <main className="flex flex-1 flex-col">{children}</main>
      </SidebarInset>
    </SidebarProvider>
  )
}
