-- Phase 11 · retained_pages snapshot table + delete-with-retain RPCs (D25, D31, D87, D-add-1)

CREATE TABLE IF NOT EXISTS public.retained_pages (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  path         text NOT NULL,
  html         text NOT NULL,
  content_sha1 text NOT NULL,
  retained_at  timestamptz NOT NULL DEFAULT now(),
  reason       text,
  lead_ref     text,
  campaign_ref text,

  CONSTRAINT retained_pages_path_uk UNIQUE (path),
  CONSTRAINT retained_pages_sha1_ck CHECK (content_sha1 ~ '^[0-9a-f]{40}$')
);

CREATE INDEX IF NOT EXISTS retained_pages_campaign_ref_idx
  ON public.retained_pages (campaign_ref);

ALTER TABLE public.retained_pages ENABLE ROW LEVEL SECURITY;

-- No RLS policy — service_role only (docs/DB.md §7).

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
    AND lp.deploy_status = 'live'
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

CREATE OR REPLACE FUNCTION public.delete_campaign_retaining_pages(
  p_campaign_id uuid,
  p_retain boolean
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
END;
$fn$;

REVOKE ALL ON FUNCTION public.delete_campaign_retaining_pages(uuid, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_campaign_retaining_pages(uuid, boolean)
  TO service_role;
