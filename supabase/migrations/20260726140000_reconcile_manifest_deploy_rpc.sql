-- Phase 11 review · reconcile_manifest_deploy() — one-statement post-deploy reconcile
--
-- Replaces the per-lead UPDATE loop in worker/db.ts. Two problems it fixes:
--
--   1. O(N) round-trips per deploy. Every lead's deploy step publishes the full
--      manifest, so a 100-lead batch issued ~10,000 UPDATEs.
--   2. Cross-lead state clobbering. The loop force-wrote status='deployed' on
--      every lead in the manifest, which reset leads that were legitimately
--      elsewhere: a lead force-restarted to `record` keeps its landing page
--      live, so it stays in the manifest and was flipped back to `deployed`
--      mid-pipeline. Phase 15's Deployed -> Ready promotion would be undone the
--      same way.
--
-- The URL and deploy timestamp are facts about the site and are written for
-- every manifest lead. The *status* transition is guarded to leads genuinely
-- completing their deploy step.

CREATE OR REPLACE FUNCTION public.reconcile_manifest_deploy(
  p_rows        jsonb,
  p_deployed_at timestamptz,
  p_deploy_id   text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
BEGIN
  -- p_rows: [{ "page_id": uuid, "campaign_lead_id": uuid, "netlify_url": text }, ...]

  UPDATE public.landing_pages lp
  SET deploy_status    = 'live',
      deployed_at      = p_deployed_at,
      netlify_deploy_id = p_deploy_id,
      error_detail     = NULL,
      unpublished_at   = NULL
  FROM jsonb_to_recordset(p_rows) AS r(
    page_id uuid,
    campaign_lead_id uuid,
    netlify_url text
  )
  WHERE lp.id = r.page_id;

  UPDATE public.campaign_leads cl
  SET netlify_url      = r.netlify_url,
      deployed_at      = p_deployed_at,
      deployed_dry_run = false,
      -- Guarded: only a lead actually finishing deploy (or already deployed,
      -- for an idempotent refresh) gets its status and error state rewritten.
      -- Excludes 'ready' (promoted), 'queued'/'processing' at another step
      -- (forced re-record), 'paused', 'failed', 'skipped'.
      status = CASE
        WHEN (cl.status = 'processing' AND cl.current_step = 'deploy')
          OR cl.status = 'deployed'
        THEN 'deployed'::public.lead_status
        ELSE cl.status
      END,
      attempt_count = CASE
        WHEN (cl.status = 'processing' AND cl.current_step = 'deploy')
          OR cl.status = 'deployed'
        THEN 0
        ELSE cl.attempt_count
      END,
      error_code = CASE
        WHEN (cl.status = 'processing' AND cl.current_step = 'deploy')
          OR cl.status = 'deployed'
        THEN NULL
        ELSE cl.error_code
      END,
      error_detail = CASE
        WHEN (cl.status = 'processing' AND cl.current_step = 'deploy')
          OR cl.status = 'deployed'
        THEN NULL
        ELSE cl.error_detail
      END
  FROM jsonb_to_recordset(p_rows) AS r(
    page_id uuid,
    campaign_lead_id uuid,
    netlify_url text
  )
  WHERE cl.id = r.campaign_lead_id;
END;
$fn$;

REVOKE ALL ON FUNCTION public.reconcile_manifest_deploy(jsonb, timestamptz, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_manifest_deploy(jsonb, timestamptz, text)
  TO service_role;
