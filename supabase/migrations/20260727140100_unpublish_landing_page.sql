-- Phase 13 · W2 — unpublish_landing_page RPC

CREATE OR REPLACE FUNCTION public.unpublish_landing_page(
  p_campaign_lead_id uuid
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_landing_page_id uuid;
  v_path text;
  v_deploy_status public.deploy_status;
BEGIN
  SELECT cl.landing_page_id, lp.path, lp.deploy_status
  INTO v_landing_page_id, v_path, v_deploy_status
  FROM public.campaign_leads cl
  LEFT JOIN public.landing_pages lp ON lp.id = cl.landing_page_id
  WHERE cl.id = p_campaign_lead_id;

  IF v_landing_page_id IS NULL OR v_path IS NULL THEN
    RAISE EXCEPTION 'campaign lead has no landing page: %', p_campaign_lead_id;
  END IF;

  IF v_deploy_status = 'removed' THEN
    RAISE NOTICE 'landing page already unpublished: %', v_path;
    RETURN;
  END IF;

  UPDATE public.landing_pages
  SET deploy_status = 'removed',
      unpublished_at = now()
  WHERE id = v_landing_page_id;

  INSERT INTO public.pipeline_events (
    campaign_lead_id,
    kind,
    step,
    message,
    meta
  )
  VALUES (
    p_campaign_lead_id,
    'unpublished',
    'deploy',
    format('Landing page unpublished: %s', v_path),
    jsonb_build_object('path', v_path)
  );

  INSERT INTO public.pending_site_sync (reason, meta)
  VALUES (
    'lead_unpublish',
    jsonb_build_object(
      'campaign_lead_id', p_campaign_lead_id,
      'path', v_path
    )
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.unpublish_landing_page(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.unpublish_landing_page(uuid)
  TO service_role;
