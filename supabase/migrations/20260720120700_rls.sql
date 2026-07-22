-- Personalizer — 08/09 · row level security
-- Spec: docs/DB.md §7.
--
-- The application connects with the service role key, which bypasses RLS
-- entirely. These policies therefore exist to guarantee that NOTHING ELSE can
-- read anything — including a leaked anon key or a misconfigured client.

ALTER TABLE public.campaigns       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.import_batches  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.leads           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.campaign_leads  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.recordings      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.intro_videos    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.videos          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.landing_pages   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.job_runs        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pipeline_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.logs            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.settings        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.heartbeat       ENABLE ROW LEVEL SECURITY;

-- §7.1 — deny-all is the default.
--
-- With RLS enabled and NO POLICY defined, PostgreSQL denies every operation for
-- non-superuser roles. Every table above except heartbeat therefore gets no
-- policies at all: writing an explicit USING (false) would be noise, and the
-- absence of a policy is the stronger and more obvious statement.

-- ---------------------------------------------------------------------------
-- Table privileges — a second, independent layer
-- ---------------------------------------------------------------------------
-- INCOMPLETE — extended by 20260722131125_default_privileges.sql. The revokes
-- below are point-in-time (they say nothing about objects created by later
-- migrations) and never covered FUNCTIONS at all. See docs/DB.md §7.1.2.
--
-- RLS alone satisfies §7. This revoke exists because the two layers fail
-- differently: RLS is per-table state that a later `ALTER TABLE ... DISABLE ROW
-- LEVEL SECURITY` or an accidental permissive policy can undo, while a missing
-- GRANT denies at the catalog level regardless. Supabase's default privileges
-- hand anon and authenticated full DML on anything created in `public`, so
-- without this the heartbeat exception is the only intentional grant among
-- thirteen accidental ones.
--
-- service_role and postgres are untouched — the application still works exactly
-- as before.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;

-- §7.3 — the one exception: heartbeat.
--
-- Insert only. No SELECT, UPDATE or DELETE policy exists, so the key cannot
-- read back even what it wrote. The WITH CHECK pins the source value, so the
-- key cannot be used to write arbitrary marker rows.
--
-- This is the whole reason the keep-alive uses a separate key: the GitHub
-- Action runs in an environment whose secrets are outside our control surface,
-- and the worst case for this key is an attacker adding rows to a table that
-- exists solely to be written to.
GRANT INSERT ON public.heartbeat TO anon;

-- The id column is GENERATED ALWAYS AS IDENTITY, whose sequence is owned by the
-- column and needs no separate USAGE grant.

DROP POLICY IF EXISTS heartbeat_insert_only ON public.heartbeat;
CREATE POLICY heartbeat_insert_only ON public.heartbeat
  FOR INSERT TO anon
  WITH CHECK (source = 'github-action');

-- §7.2 — Realtime respects RLS. The dashboard subscribes through the SERVER,
-- not the browser, so the subscription uses the service role and no policy is
-- needed to make live updates work. Should a future change move subscriptions
-- into the browser, that requires a real auth model — not a loosened policy.
