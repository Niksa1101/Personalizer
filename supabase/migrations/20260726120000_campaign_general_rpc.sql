-- Phase 10 review · update_campaign_general() — atomic campaign update + landing path rewrite

CREATE OR REPLACE FUNCTION public.update_campaign_general(
  p_campaign_id uuid,
  p_name        text,
  p_slug        text,
  p_description text
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
  SET name = p_name,
      slug = p_slug,
      description = p_description
  WHERE id = p_campaign_id;

  UPDATE public.landing_pages lp
  SET path = '/' || p_slug || '/' || cl.slug,
      deploy_status = 'pending',
      unpublished_at = NULL
  FROM public.campaign_leads cl
  WHERE lp.campaign_lead_id = cl.id
    AND cl.campaign_id = p_campaign_id
    AND lp.path IS DISTINCT FROM ('/' || p_slug || '/' || cl.slug);
END;
$fn$;

REVOKE ALL ON FUNCTION public.update_campaign_general(uuid, text, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_campaign_general(uuid, text, text, text)
  TO service_role;

DROP FUNCTION IF EXISTS public.rename_campaign_slug(uuid, text);
