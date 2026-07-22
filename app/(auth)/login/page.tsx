import { redirect } from "next/navigation"

import { LoginForm } from "@/components/login-form"
import { getSession } from "@/lib/dal"
import { safeNext } from "@/lib/next-path"

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>
}) {
  const session = await getSession()
  const params = await searchParams
  const nextPath = safeNext(params.next)

  if (session) {
    redirect(nextPath)
  }

  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <LoginForm next={nextPath} />
    </div>
  )
}
