import { unauthorizedResponse, verifySession } from "@/lib/dal"
import { getLandingPageForLead } from "@/lib/campaigns"

export const runtime = "nodejs"

type RouteContext = {
  params: Promise<{ campaignLeadId: string }>
}

export async function GET(_request: Request, context: RouteContext) {
  try {
    await verifySession()
  } catch {
    return unauthorizedResponse()
  }

  const { campaignLeadId } = await context.params
  const landingPage = await getLandingPageForLead(campaignLeadId)

  if (!landingPage) {
    return new Response(null, { status: 404 })
  }

  return new Response(landingPage.html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": "sandbox",
      "X-Content-Type-Options": "nosniff",
    },
  })
}
