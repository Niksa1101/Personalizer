-- Personalizer — 07/09 · indexes
-- Spec: docs/DB.md §6.
--
-- Primary keys and unique CONSTRAINTS are declared with their tables. So are
-- the indexes DB.md names inline in §5 (recordings_lead_active_uk,
-- job_runs_*, pipeline_events_lead_idx, logs_*) — they read as part of those
-- tables' definitions. This file holds the §6 set: the access paths the
-- dashboard, the importer and the worker depend on.

-- ---------------------------------------------------------------------------
-- Dedupe: global, on normalized domain OR email (§6.1).
-- ---------------------------------------------------------------------------
-- Two partial unique indexes rather than one composite. A composite
-- (domain, email) would treat ('acme.com', NULL) and ('acme.com', 'jo@acme.com')
-- as distinct, which is exactly the collision we need to catch. Partial,
-- because most leads have one identifier but not both.
--
-- These are the backstop that makes a concurrent double-import fail loudly
-- rather than duplicate; the importer checks both keys before inserting.
CREATE UNIQUE INDEX IF NOT EXISTS leads_domain_uk ON public.leads (domain) WHERE domain IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS leads_email_uk  ON public.leads (email)  WHERE email  IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Dashboard: campaign-scoped status filtering, plus the "All campaigns" view.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS campaign_leads_campaign_status_idx
  ON public.campaign_leads (campaign_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS campaign_leads_status_idx
  ON public.campaign_leads (status, created_at DESC);
CREATE INDEX IF NOT EXISTS campaign_leads_bucket_idx
  ON public.campaign_leads (error_bucket) WHERE error_bucket IS NOT NULL;
CREATE INDEX IF NOT EXISTS campaign_leads_lead_idx  ON public.campaign_leads (lead_id);
CREATE INDEX IF NOT EXISTS campaign_leads_batch_idx ON public.campaign_leads (batch_id);

-- ---------------------------------------------------------------------------
-- Worker: claim queued work, and find orphans at boot (docs/Tech.md §7.4).
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS campaign_leads_queued_idx
  ON public.campaign_leads (created_at) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS campaign_leads_processing_idx
  ON public.campaign_leads (started_at) WHERE status = 'processing';

-- ---------------------------------------------------------------------------
-- Retention sweep (docs/Tech.md §7.5).
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS recordings_purge_idx
  ON public.recordings (recorded_at) WHERE purged_at IS NULL AND local_path IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Deploy manifest assembly (docs/Tech.md §10.3).
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS landing_pages_deploy_status_idx
  ON public.landing_pages (deploy_status);
