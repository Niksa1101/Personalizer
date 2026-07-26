/**
 * Payload shape for the `reconcile_manifest_deploy` RPC. Kept pure and separate
 * from worker/db.ts so the URL joining is unit-testable without Supabase.
 */
export type ManifestReconcileRow = {
  page_id: string
  campaign_lead_id: string
  netlify_url: string
}

type ReconcilablePage = {
  id: string
  campaign_lead_id: string
  path: string
}

/** Netlify's ssl_url and our stored paths both carry slashes; join exactly one. */
export function joinSiteUrl(siteUrl: string, path: string): string {
  const base = siteUrl.replace(/\/+$/, "")
  const suffix = path.startsWith("/") ? path : `/${path}`
  return `${base}${suffix}`
}

export function buildReconcileRows(
  pages: readonly ReconcilablePage[],
  siteUrl: string,
): ManifestReconcileRow[] {
  return pages.map((page) => ({
    page_id: page.id,
    campaign_lead_id: page.campaign_lead_id,
    netlify_url: joinSiteUrl(siteUrl, page.path),
  }))
}
