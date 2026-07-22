-- Personalizer — 11 · default privileges, and the functions migration 07 missed
-- Spec: docs/DB.md §7.1.1.
--
-- Migration 07 revoked anon/authenticated on every table and sequence then in
-- existence. Two gaps were found by measuring the live project rather than
-- reading the migration:
--
--   1. `REVOKE ... ON ALL TABLES` is POINT-IN-TIME. It says nothing about
--      objects created later. pg_default_acl on this project still carries, for
--      granting role `postgres` in schema `public`:
--          tables    anon=arwdDxtm  authenticated=arwdDxtm
--          sequences anon=rwU       authenticated=rwU
--          functions anon=X         authenticated=X
--      so the next migration that creates an object hands anon full access to
--      it unless someone remembers to revoke by hand.
--
--   2. `ALL TABLES` never covered FUNCTIONS at all. seed_demo_data() was
--      revoked individually (20260720120900_seed_function.sql), which is
--      precisely the "remember by hand" failure mode — and the four helpers
--      from migration 03 were not remembered. normalize_domain(),
--      error_code_bucket(), next_lead_ref() and next_campaign_ref() are all
--      anon-EXECUTE-able over PostgREST RPC today.
--
-- Nothing here is currently exploitable: the two ref functions are invoker
-- rights and anon has no USAGE on the sequences, so they fail; the other two
-- are pure. This migration is about the objects Phases 4–16 will add.
--
-- Note what this is NOT about. The live project has a Supabase platform event
-- trigger, public.rls_auto_enable(), which enables RLS on every new table in
-- `public`. That nets TABLES. It does not net VIEWS (no RLS of their own, and
-- the trigger only fires on CREATE TABLE) and it does not net FUNCTIONS. Those
-- two are the real exposure, and they are what the default privileges below
-- close.

-- ---------------------------------------------------------------------------
-- Forward-looking: objects created from here on
-- ---------------------------------------------------------------------------
-- ALTER DEFAULT PRIVILEGES binds to the CURRENT ROLE. Migrations run as
-- `postgres`, which is the role whose default ACLs carry the anon grants, so
-- this is the one that matters. The parallel `supabase_admin` entries are
-- platform-owned and deliberately left alone.
--
-- PUBLIC is included for functions because PostgreSQL grants EXECUTE to PUBLIC
-- on every new function regardless of Supabase's defaults. service_role and
-- postgres hold their own explicit grants, so revoking from PUBLIC does not
-- touch the application — same reasoning, and same wording, as the revoke in
-- 20260720120900_seed_function.sql.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES    FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Catch-up: the functions that already exist
-- ---------------------------------------------------------------------------
-- Trigger and event-trigger functions are unaffected in practice — trigger
-- function privileges are checked at CREATE TRIGGER time, not at fire time —
-- and generated columns (campaign_leads.error_bucket over error_code_bucket)
-- resolve the same way. The application connects as service_role, which keeps
-- its grant either way.
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, anon, authenticated;

-- Re-assert the table and sequence revokes from migration 07. Idempotent, and
-- it means this one file is a complete statement of the privilege posture
-- rather than half of one spread across two migrations.
REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;

-- ...except the one intentional grant. The re-assert above would otherwise
-- silently undo §7.3 and break the keep-alive (docs/Tech.md §15).
GRANT INSERT ON public.heartbeat TO anon;
