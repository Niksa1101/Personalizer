-- Phase 13 · W1 — widen snapshot_live_pages + delete_lead_retaining_pages

DROP FUNCTION public.snapshot_live_pages(uuid[]);

CREATE FUNCTION public.snapshot_live_pages(
  p_campaign_lead_ids uuid[],
  p_reason text DEFAULT 'campaign_delete_retain'
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
BEGIN
  INSERT INTO public.retained_pages (
    path,
    html,
    content_sha1,
    retained_at,
    reason,
    lead_ref,
    campaign_ref
  )
  SELECT
    lp.path,
    lp.html,
    lp.content_sha1,
    now(),
    p_reason,
    l.ref,
    c.ref
  FROM public.landing_pages lp
  JOIN public.campaign_leads cl ON cl.id = lp.campaign_lead_id
  JOIN public.campaigns c ON c.id = cl.campaign_id
  JOIN public.leads l ON l.id = cl.lead_id
  WHERE lp.campaign_lead_id = ANY (p_campaign_lead_ids)
    AND lp.deploy_status IN ('pending', 'uploading', 'live', 'failed')
    AND lp.html IS NOT NULL
    AND lp.content_sha1 IS NOT NULL
  ON CONFLICT (path) DO UPDATE SET
    html = EXCLUDED.html,
    content_sha1 = EXCLUDED.content_sha1,
    retained_at = EXCLUDED.retained_at,
    reason = EXCLUDED.reason,
    lead_ref = EXCLUDED.lead_ref,
    campaign_ref = EXCLUDED.campaign_ref;
END;
$fn$;

REVOKE ALL ON FUNCTION public.snapshot_live_pages(uuid[], text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.snapshot_live_pages(uuid[], text)
  TO service_role;

CREATE OR REPLACE FUNCTION public.delete_lead_retaining_pages(
  p_campaign_lead_id uuid,
  p_retain boolean
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_lead_ref text;
  v_campaign_ref text;
BEGIN
  SELECT l.ref, c.ref
  INTO v_lead_ref, v_campaign_ref
  FROM public.campaign_leads cl
  JOIN public.leads l ON l.id = cl.lead_id
  JOIN public.campaigns c ON c.id = cl.campaign_id
  WHERE cl.id = p_campaign_lead_id;

  IF v_lead_ref IS NULL THEN
    RAISE EXCEPTION 'campaign lead not found: %', p_campaign_lead_id;
  END IF;

  IF p_retain THEN
    PERFORM public.snapshot_live_pages(
      ARRAY[p_campaign_lead_id],
      'lead_delete_retain'
    );
  END IF;

  DELETE FROM public.campaign_leads WHERE id = p_campaign_lead_id;

  INSERT INTO public.pending_site_sync (reason, meta)
  VALUES (
    'lead_delete',
    jsonb_build_object(
      'campaign_lead_id', p_campaign_lead_id,
      'lead_ref', v_lead_ref,
      'campaign_ref', v_campaign_ref,
      'retain', p_retain
    )
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.delete_lead_retaining_pages(uuid, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_lead_retaining_pages(uuid, boolean)
  TO service_role;
