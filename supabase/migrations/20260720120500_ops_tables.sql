-- Personalizer — 06/09 · operational tables
-- Spec: docs/DB.md §5.9–5.13.
--
-- job_runs · pipeline_events · logs · settings · heartbeat
--
-- Two logging streams, deliberately separate (docs/Tech.md §13):
--   pipeline_events — operator-facing timeline for ONE lead, rendered in the drawer
--   logs           — system-facing: stack traces, FFmpeg stderr, Netlify responses

-- ---------------------------------------------------------------------------
-- §5.9 job_runs
-- ---------------------------------------------------------------------------
-- One worker attempt at one step. The retry and timing record. Distinct from
-- lead_status: a campaign_leads row has one status, but many job_runs.
CREATE TABLE IF NOT EXISTS public.job_runs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_lead_id uuid NOT NULL REFERENCES public.campaign_leads(id) ON DELETE CASCADE,
  step             public.pipeline_step NOT NULL,
  state            public.job_state NOT NULL DEFAULT 'running',
  attempt          integer NOT NULL DEFAULT 1,   -- 1-based within this step
  queue_job_id     text,   -- BullMQ job id, for cross-referencing worker logs
  worker_id        text,   -- host + PID; matters once concurrency > 1
  error_code       public.error_code,
  error_detail     text,
  started_at       timestamptz NOT NULL DEFAULT now(),
  -- Null while running, or forever if the worker was killed and boot recovery
  -- marked this run 'interrupted'.
  finished_at      timestamptz,
  -- Immutable by construction: timestamptz subtraction yields an interval, and
  -- EXTRACT(epoch FROM interval) is immutable — which is what makes this legal
  -- in a generated column at all.
  duration_ms      integer GENERATED ALWAYS AS (
                     (EXTRACT(epoch FROM (finished_at - started_at)) * 1000)::integer
                   ) STORED,

  CONSTRAINT job_runs_attempt_ck CHECK (attempt >= 1)
);

CREATE INDEX IF NOT EXISTS job_runs_lead_step_idx
  ON public.job_runs (campaign_lead_id, step, started_at DESC);

-- What boot recovery scans (docs/Tech.md §7.4). Partial, so it stays tiny
-- regardless of how much history accumulates.
CREATE INDEX IF NOT EXISTS job_runs_running_idx
  ON public.job_runs (started_at) WHERE state = 'running';

-- ---------------------------------------------------------------------------
-- §5.10 pipeline_events
-- ---------------------------------------------------------------------------
-- The append-only timeline shown in the lead detail drawer. Never updated,
-- never deleted except by cascade. Monotonic ordering matters more than
-- opacity here, hence a bigint identity rather than a uuid.
CREATE TABLE IF NOT EXISTS public.pipeline_events (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  campaign_lead_id uuid NOT NULL REFERENCES public.campaign_leads(id) ON DELETE CASCADE,
  kind             public.event_kind NOT NULL,
  -- Null for events that are not step-scoped (imported, promoted).
  step             public.pipeline_step,
  -- Operator-readable, written for the drawer.
  message          text NOT NULL,
  error_code       public.error_code,
  -- Structured extras: {attempt: 2, duration_ms: 8412, stretch_factor: 1.8}
  meta             jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- id DESC is a tiebreaker, not decoration: several events can share a timestamp
-- within a fast step, and the drawer must order them deterministically.
CREATE INDEX IF NOT EXISTS pipeline_events_lead_idx
  ON public.pipeline_events (campaign_lead_id, created_at DESC, id DESC);

-- ---------------------------------------------------------------------------
-- §5.11 logs
-- ---------------------------------------------------------------------------
-- System-wide structured logging. Not per-lead — that is pipeline_events. This
-- is where stack traces, FFmpeg stderr and Netlify responses go.
CREATE TABLE IF NOT EXISTS public.logs (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  level            public.log_level NOT NULL DEFAULT 'info',
  -- importer / recorder / merger / deployer / web / worker
  scope            text NOT NULL,
  message          text NOT NULL,
  -- SET NULL rather than CASCADE is deliberate: deleting a lead should not
  -- erase the record of what the system did. Logs outlive their subject.
  campaign_lead_id uuid REFERENCES public.campaign_leads(id) ON DELETE SET NULL,
  job_run_id       uuid REFERENCES public.job_runs(id)       ON DELETE SET NULL,
  meta             jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS logs_created_idx ON public.logs (created_at DESC);
CREATE INDEX IF NOT EXISTS logs_level_idx
  ON public.logs (level, created_at DESC) WHERE level IN ('warn','error');

-- ---------------------------------------------------------------------------
-- §5.12 settings
-- ---------------------------------------------------------------------------
-- Global defaults, one row per key. Campaign-level and lead-level overrides
-- live on their own tables; this is the BOTTOM of the resolution chain.
-- Resolution is always lead override → campaign value → settings default, which
-- is why the override columns in §5.4 are nullable rather than defaulted.
CREATE TABLE IF NOT EXISTS public.settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,          -- typed by key
  description text,                    -- rendered as help text on the Settings screen
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE TRIGGER settings_touch_updated_at
  BEFORE UPDATE ON public.settings
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- §5.13 heartbeat
-- ---------------------------------------------------------------------------
-- Keeps the Supabase project from being paused for inactivity. Written by a
-- daily GitHub Actions cron.
--
-- This is the ONLY table reachable by a non-service key. The cron uses a
-- narrowly scoped insert-only anon key; the service role key must never enter
-- GitHub secrets, because a leaked service key is unrestricted access to every
-- table above (§7.3, docs/Tech.md §15).
CREATE TABLE IF NOT EXISTS public.heartbeat (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source     text NOT NULL DEFAULT 'github-action',
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Realtime
-- ---------------------------------------------------------------------------
-- The dashboard subscribes to pipeline_events and campaign_leads through the
-- server, with a 5-second polling fallback (docs/DB.md §5.10, Tech.md §13).
-- Replica identity FULL so an UPDATE payload carries the old row too, which is
-- what lets the dashboard diff a status transition rather than just observe the
-- new value.
ALTER TABLE public.campaign_leads  REPLICA IDENTITY FULL;
ALTER TABLE public.pipeline_events REPLICA IDENTITY FULL;

DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.campaign_leads;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.pipeline_events;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
