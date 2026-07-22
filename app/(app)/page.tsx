import { SignOutButton } from "@/components/sign-out-button"

export default function DashboardPage() {
  return (
    <main className="flex flex-1 flex-col gap-4 p-6">
      <h1 className="text-2xl font-semibold">Dashboard</h1>
      <p className="text-muted-foreground">Phase 3 will build this screen.</p>
      <SignOutButton />
    </main>
  )
}
