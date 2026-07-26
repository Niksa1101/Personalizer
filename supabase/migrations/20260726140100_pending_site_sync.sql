-- Phase 11 review · durable pending-sync marker
--
-- Redis was the only record that a published page needed unpublishing. If Redis
-- was unreachable when a campaign was deleted, enqueueSiteSync() threw before
-- setDeployDirty() ran, the campaign rows were already gone, and boot recovery
-- gates on the dirty flag — so the pages stayed live forever with nothing left
-- to reconcile against.
--
-- The marker is now written inside the same transaction as the destructive
-- change, so it cannot be lost. Redis stays as the fast path; this table is the
-- system of record.

CREATE TABLE IF NOT EXISTS public.pending_site_sync (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reason       text NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  meta         jsonb
);

CREATE INDEX IF NOT EXISTS pending_site_sync_requested_at_idx
  ON public.pending_site_sync (requested_at);

ALTER TABLE public.pending_site_sync ENABLE ROW LEVEL SECURITY;

-- No RLS policy — service_role only (docs/DB.md §7), same posture as retained_pages.

-- Widened from deploy_status = 'live' to the manifest-eligible set. A campaign
-- whose pages are 'pending'/'uploading'/'failed' is still published on Netlify
-- (the row status lags the site), so retaining only 'live' pages silently 404'd
-- pages the operator asked to keep. Mirrors MANIFEST_DEPLOY_STATUSES in worker/db.ts.
CREATE OR REPLACE FUNCTION public.snapshot_live_pages(
  p_campaign_lead_ids uuid[]
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
    'campaign_delete_retain',
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

REVOKE ALL ON FUNCTION public.snapshot_live_pages(uuid[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.snapshot_live_pages(uuid[])
  TO service_role;

-- Delete now records its own need-to-sync atomically with the delete.
CREATE OR REPLACE FUNCTION public.delete_campaign_retaining_pages(
  p_campaign_id uuid,
  p_retain boolean
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_campaign_ref text;
BEGIN
  SELECT ref INTO v_campaign_ref
  FROM public.campaigns
  WHERE id = p_campaign_id;

  IF v_campaign_ref IS NULL THEN
    RAISE EXCEPTION 'campaign not found: %', p_campaign_id;
  END IF;

  IF p_retain THEN
    PERFORM public.snapshot_live_pages(
      ARRAY(
        SELECT id
        FROM public.campaign_leads
        WHERE campaign_id = p_campaign_id
      )
    );
  END IF;

  DELETE FROM public.campaigns WHERE id = p_campaign_id;

  INSERT INTO public.pending_site_sync (reason, meta)
  VALUES (
    'campaign_delete',
    jsonb_build_object(
      'campaign_id', p_campaign_id,
      'campaign_ref', v_campaign_ref,
      'retain', p_retain
    )
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.delete_campaign_retaining_pages(uuid, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_campaign_retaining_pages(uuid, boolean)
  TO service_role;

-- A slug change rewrites every landing_pages.path for the campaign, so the
-- published URLs move. Same durability hole, same fix.
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
DECLARE
  v_moved integer;
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

  WITH moved AS (
    UPDATE public.landing_pages lp
    SET path = '/' || p_slug || '/' || cl.slug,
        deploy_status = 'pending',
        unpublished_at = NULL
    FROM public.campaign_leads cl
    WHERE lp.campaign_lead_id = cl.id
      AND cl.campaign_id = p_campaign_id
      AND lp.path IS DISTINCT FROM ('/' || p_slug || '/' || cl.slug)
    RETURNING lp.id
  )
  SELECT count(*) INTO v_moved FROM moved;

  IF v_moved > 0 THEN
    INSERT INTO public.pending_site_sync (reason, meta)
    VALUES (
      'campaign_slug_change',
      jsonb_build_object(
        'campaign_id', p_campaign_id,
        'slug', p_slug,
        'moved_pages', v_moved
      )
    );
  END IF;
END;
$fn$;

REVOKE ALL ON FUNCTION public.update_campaign_general(uuid, text, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_campaign_general(uuid, text, text, text)
  TO service_role;
