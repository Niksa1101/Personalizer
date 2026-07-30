-- Phase 15 · W2 — promote / unpromote RPCs

CREATE OR REPLACE FUNCTION public.promote_campaign_leads(
  p_ids uuid[],
  p_trigger text DEFAULT 'bulk'
) RETURNS TABLE (campaign_lead_id uuid, lead_ref text, outcome text, reason text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_promoted uuid[] := '{}';
  v_len int;
BEGIN
  v_len := COALESCE(array_length(p_ids, 1), 0);
  IF v_len = 0 THEN RETURN; END IF;
  IF v_len > 200 THEN
    RAISE EXCEPTION 'promote_campaign_leads: % ids exceeds the 200 cap', v_len;
  END IF;

  WITH upd AS (
    UPDATE public.campaign_leads cl
       SET status = 'ready', promoted_at = now()
     WHERE cl.id = ANY(p_ids)
       AND cl.status = 'deployed'
       AND cl.netlify_url IS NOT NULL
       AND EXISTS (SELECT 1 FROM public.v_exportable_leads x
                    WHERE x.id = cl.id AND x.is_page_removed = false)
    RETURNING cl.id
  )
  SELECT COALESCE(array_agg(id), '{}') INTO v_promoted FROM upd;

  IF array_length(v_promoted, 1) IS NOT NULL THEN
    INSERT INTO public.pipeline_events (campaign_lead_id, kind, step, message, meta)
    SELECT u, 'promoted', NULL, 'Promoted to Ready',
           jsonb_build_object('prior_status', 'deployed', 'trigger', p_trigger)
      FROM unnest(v_promoted) AS u;
  END IF;

  RETURN QUERY
  SELECT
    i.id,
    COALESCE(l.ref, '')::text,
    CASE WHEN i.id = ANY(v_promoted) THEN 'success' ELSE 'skipped' END::text,
    CASE
      WHEN i.id = ANY(v_promoted)  THEN NULL
      WHEN cl.id IS NULL           THEN 'not_found'
      WHEN cl.status <> 'deployed' THEN 'not_deployed'
      WHEN cl.netlify_url IS NULL  THEN 'no_live_url'
      ELSE 'page_unpublished'
    END::text
  FROM unnest(p_ids) AS i(id)
  LEFT JOIN public.campaign_leads cl ON cl.id = i.id
  LEFT JOIN public.leads          l  ON l.id = cl.lead_id;
END;
$fn$;

REVOKE ALL ON FUNCTION public.promote_campaign_leads(uuid[], text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.promote_campaign_leads(uuid[], text)
  TO service_role;

CREATE OR REPLACE FUNCTION public.unpromote_campaign_lead(p_campaign_lead_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
BEGIN
  UPDATE public.campaign_leads
     SET status = 'deployed', promoted_at = NULL
   WHERE id = p_campaign_lead_id AND status = 'ready';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'campaign lead is not ready: %', p_campaign_lead_id;
  END IF;

  INSERT INTO public.pipeline_events (campaign_lead_id, kind, step, message, meta)
  VALUES (
    p_campaign_lead_id,
    'note',
    NULL,
    'Returned to Deployed — approval withdrawn',
    jsonb_build_object('prior_status', 'ready', 'trigger', 'drawer')
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.unpromote_campaign_lead(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.unpromote_campaign_lead(uuid)
  TO service_role;
