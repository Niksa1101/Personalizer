-- Phase 10 · rename_campaign_slug() — atomic slug + landing_pages.path rewrite (D41)

CREATE OR REPLACE FUNCTION public.rename_campaign_slug(
  p_campaign_id uuid,
  p_slug        text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.campaigns WHERE id = p_campaign_id
  ) THEN
    RAISE EXCEPTION 'campaign not found: %', p_campaign_id;
  END IF;

  UPDATE public.campaigns
  SET slug = p_slug
  WHERE id = p_campaign_id;

  UPDATE public.landing_pages lp
  SET path = '/' || p_slug || '/' || cl.slug
  FROM public.campaign_leads cl
  WHERE lp.campaign_lead_id = cl.id
    AND cl.campaign_id = p_campaign_id;
END;
$fn$;

REVOKE ALL ON FUNCTION public.rename_campaign_slug(uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rename_campaign_slug(uuid, text)
  TO service_role;
