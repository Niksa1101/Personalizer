-- Lift the ETA sample rule out of dashboard_counts() into one function.
--
-- `20260726160000` carried the sample definition twice: once scoped to the
-- campaign, once unscoped for the <3-sample fallback. Two copies of "which
-- durations are honest" is a drift waiting to happen — the next change to the
-- exclusion list only has to miss one of them.
--
-- The obvious de-duplication is wrong: a single global pool of 100 filtered down
-- to a campaign is NOT the scoped pool. A campaign whose recent deploys fall
-- outside the global 100 most recent would silently get zero scoped samples and
-- drop to the fallback. The LIMIT has to be applied per scope, so the parameter
-- has to reach inside the query — which is what a function does and a CTE
-- cannot. Semantics are unchanged: same predicate, same 100-then-20 narrowing,
-- same ordering, same fallback threshold.
--
-- Grants follow dashboard_counts() and the §7.1.2 lesson that `ALL TABLES` never
-- covered functions: every new one is revoked explicitly rather than assumed.

CREATE OR REPLACE FUNCTION public.dashboard_eta_samples(
  p_campaign_id      uuid,                     -- NULL = every campaign
  p_include_archived boolean
) RETURNS double precision[]
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $eta$
  WITH candidates AS (
    SELECT
      cl.id,
      cl.deployed_at,
      EXTRACT(EPOCH FROM (cl.deployed_at - cl.started_at)) AS seconds
    FROM public.campaign_leads cl
    JOIN public.campaigns c ON c.id = cl.campaign_id
    WHERE cl.status IN ('deployed', 'ready')
      AND cl.started_at IS NOT NULL
      AND cl.deployed_at IS NOT NULL
      AND cl.deployed_dry_run = false
      AND cl.deployed_at > cl.started_at
      AND (p_campaign_id IS NULL OR cl.campaign_id = p_campaign_id)
      AND (p_include_archived OR c.archived_at IS NULL)
    ORDER BY cl.deployed_at DESC
    LIMIT 100
  ),
  clean AS (
    -- A lead that was interrupted, paused or retried did not take the time the
    -- clock says it took, so it must not shape anyone's estimate.
    SELECT c.seconds
    FROM candidates c
    WHERE NOT EXISTS (
      SELECT 1
      FROM public.pipeline_events pe
      WHERE pe.campaign_lead_id = c.id
        AND pe.kind IN ('interrupted', 'paused', 'retry_scheduled')
    )
    ORDER BY c.deployed_at DESC
    LIMIT 20
  )
  SELECT COALESCE(array_agg(seconds), ARRAY[]::double precision[]) FROM clean
$eta$;

REVOKE ALL ON FUNCTION public.dashboard_eta_samples(uuid, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.dashboard_eta_samples(uuid, boolean) TO service_role;

CREATE OR REPLACE FUNCTION public.dashboard_counts(
  p_campaign_id      uuid    DEFAULT NULL,   -- NULL = all campaigns
  p_include_archived boolean DEFAULT false
) RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
  WITH scope AS (
    SELECT cl.*, c.name AS campaign_name, c.intro_video_id, c.archived_at
    FROM public.campaign_leads cl
    JOIN public.campaigns c ON c.id = cl.campaign_id
    WHERE (p_campaign_id IS NULL OR cl.campaign_id = p_campaign_id)
      AND (p_include_archived OR c.archived_at IS NULL)
  ),
  tiles AS (
    SELECT COALESCE(
      jsonb_object_agg(e.status::text, COALESCE(c.cnt, 0)),
      '{}'::jsonb
    ) AS val
    FROM unnest(enum_range(NULL::public.lead_status)) AS e(status)
    LEFT JOIN (
      SELECT s.status, COUNT(*)::int AS cnt
      FROM scope s
      GROUP BY s.status
    ) c ON c.status = e.status
  ),
  dry_run AS (
    SELECT COUNT(*)::int AS val
    FROM scope s
    WHERE s.status IN ('deployed', 'ready')
      AND s.deployed_dry_run = true
  ),
  buckets AS (
    SELECT COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'bucket', b.error_bucket,
          'count', b.cnt,
          'error_code', b.error_code
        )
        ORDER BY b.error_bucket
      ),
      '[]'::jsonb
    ) AS val
    FROM (
      SELECT
        s.error_bucket,
        MODE() WITHIN GROUP (ORDER BY s.error_code) AS error_code,
        COUNT(*)::int AS cnt
      FROM scope s
      WHERE s.status = 'failed'
        AND s.error_bucket IS NOT NULL
      GROUP BY s.error_bucket
    ) b
  ),
  batch_ordinals AS (
    SELECT
      ib.id AS batch_id,
      ib.campaign_id,
      ROW_NUMBER() OVER (
        PARTITION BY ib.campaign_id
        ORDER BY ib.created_at
      )::int AS ordinal
    FROM public.import_batches ib
  ),
  active_batches AS (
    SELECT
      s.batch_id,
      s.campaign_id,
      MAX(s.campaign_name) AS campaign_name,
      COUNT(*) FILTER (WHERE s.status IN ('deployed', 'ready'))::int AS done,
      COUNT(*) FILTER (WHERE s.status = 'failed')::int AS failed,
      COUNT(*) FILTER (WHERE s.status = 'paused')::int AS paused,
      COUNT(*) FILTER (WHERE s.status IN ('queued', 'processing'))::int AS remaining,
      COUNT(*) FILTER (WHERE s.status = 'skipped')::int AS skipped,
      COUNT(*) FILTER (WHERE s.status <> 'skipped')::int AS total,
      MIN(s.queued_at) FILTER (WHERE s.status = 'queued') AS oldest_queued_at
    FROM scope s
    WHERE s.batch_id IS NOT NULL
    GROUP BY s.batch_id, s.campaign_id
    HAVING COUNT(*) FILTER (
      WHERE s.status IN ('queued', 'processing', 'paused')
    ) >= 1
  ),
  batches AS (
    SELECT COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'batch_id', ab.batch_id,
          'ordinal', bo.ordinal,
          'campaign_id', ab.campaign_id,
          'campaign_name', ab.campaign_name,
          'done', ab.done,
          'failed', ab.failed,
          'paused', ab.paused,
          'remaining', ab.remaining,
          'skipped', ab.skipped,
          'total', ab.total,
          'oldest_queued_at', ab.oldest_queued_at
        )
        ORDER BY ab.oldest_queued_at NULLS LAST
      ),
      '[]'::jsonb
    ) AS val
    FROM active_batches ab
    JOIN batch_ordinals bo ON bo.batch_id = ab.batch_id
  ),
  processing_rows AS (
    SELECT
      s.id,
      s.campaign_id,
      s.campaign_name,
      s.current_step,
      s.attempt_count,
      l.full_name AS name,
      l.company,
      ev.created_at AS step_started_at
    FROM scope s
    JOIN public.leads l ON l.id = s.lead_id
    LEFT JOIN LATERAL (
      SELECT pe.created_at
      FROM public.pipeline_events pe
      WHERE pe.campaign_lead_id = s.id
        AND pe.kind = 'step_started'
        AND pe.step = s.current_step
      ORDER BY pe.created_at DESC, pe.id DESC
      LIMIT 1
    ) ev ON TRUE
    WHERE s.status = 'processing'
    -- ASC = oldest step start first = longest elapsed first, which is what the
    -- UI claims and what the LIMIT below must keep: the long-running rows are
    -- the stall candidates. NULLS LAST so unknown-elapsed rows don't squat.
    ORDER BY ev.created_at ASC NULLS LAST
    LIMIT 10
  ),
  processing AS (
    SELECT COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'id', pr.id,
          'campaign_id', pr.campaign_id,
          'campaign_name', pr.campaign_name,
          'current_step', pr.current_step,
          'attempt_count', pr.attempt_count,
          'name', pr.name,
          'company', pr.company,
          'step_started_at', pr.step_started_at
        )
        ORDER BY pr.step_started_at ASC NULLS LAST
      ),
      '[]'::jsonb
    ) AS val
    FROM processing_rows pr
  ),
  processing_total AS (
    SELECT COUNT(*)::int AS val
    FROM scope s
    WHERE s.status = 'processing'
  ),
  paused_campaigns AS (
    SELECT COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'campaign_id', pc.campaign_id,
          'campaign_name', pc.campaign_name,
          'paused_count', pc.paused_count,
          'intro_assigned', pc.intro_assigned
        )
      ),
      '[]'::jsonb
    ) AS val
    FROM (
      SELECT
        s.campaign_id,
        s.campaign_name,
        COUNT(*)::int AS paused_count,
        (s.intro_video_id IS NOT NULL) AS intro_assigned
      FROM scope s
      WHERE s.status = 'paused'
        AND s.error_code = 'intro_missing'
      GROUP BY s.campaign_id, s.campaign_name, s.intro_video_id
    ) pc
  ),
  eta_scoped AS (
    SELECT public.dashboard_eta_samples(p_campaign_id, p_include_archived) AS val
  ),
  eta_samples AS (
    SELECT CASE
             WHEN COALESCE(array_length(es.val, 1), 0) >= 3 THEN es.val
             ELSE public.dashboard_eta_samples(NULL, p_include_archived)
           END AS val
    FROM eta_scoped es
  ),
  has_campaigns AS (
    SELECT EXISTS (
      SELECT 1
      FROM public.campaigns c
      WHERE (p_campaign_id IS NULL OR c.id = p_campaign_id)
        AND (p_include_archived OR c.archived_at IS NULL)
    ) AS val
  )
  SELECT jsonb_build_object(
    'tiles', (SELECT val FROM tiles),
    'dry_run_count', (SELECT val FROM dry_run),
    'buckets', (SELECT val FROM buckets),
    'batches', (SELECT val FROM batches),
    'processing', (SELECT val FROM processing),
    'processing_total', (SELECT val FROM processing_total),
    'paused_campaigns', (SELECT val FROM paused_campaigns),
    'eta_samples', (SELECT val FROM eta_samples),
    'has_campaigns', (SELECT val FROM has_campaigns),
    'generated_at', now()
  )
$fn$;

REVOKE ALL ON FUNCTION public.dashboard_counts(uuid, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.dashboard_counts(uuid, boolean) TO service_role;
