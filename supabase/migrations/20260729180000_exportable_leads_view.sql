-- Phase 15 · W1 — v_exportable_leads (shared promote/export predicate)

CREATE OR REPLACE VIEW public.v_exportable_leads
WITH (security_invoker = true) AS
SELECT
  cl.id,
  cl.campaign_id,
  cl.status,
  (c.archived_at IS NOT NULL)                   AS campaign_archived,
  COALESCE(lp.deploy_status = 'removed', false) AS is_page_removed,
  l.ref                                         AS lead_ref,
  l.first_name, l.last_name, l.full_name, l.company,
  l.email::text                                 AS email,
  l.phone, l.website_url, l.city, l.state, l.country, l.industry,
  c.name                                        AS campaign_name,
  c.ref                                         AS campaign_ref,
  cl.netlify_url                                AS landing_url,
  v.web_public_url                              AS video_url,
  cl.deployed_at,
  cl.promoted_at
FROM public.campaign_leads cl
JOIN      public.leads         l  ON l.id  = cl.lead_id
JOIN      public.campaigns     c  ON c.id  = cl.campaign_id
LEFT JOIN public.landing_pages lp ON lp.id = cl.landing_page_id
LEFT JOIN public.videos        v  ON v.id  = cl.video_id;

REVOKE ALL ON public.v_exportable_leads FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.v_exportable_leads TO service_role;
