-- Personalizer — 03/09 · functions, sequences and triggers
-- Spec: docs/DB.md §4.
--
-- Every function pins an empty search_path. These are called from generated
-- columns and triggers that run under whatever search_path the caller happens
-- to have; pinning removes the schema-resolution ambiguity entirely. Anything
-- outside pg_catalog is therefore schema-qualified below.

-- §4.1 — audit column maintenance, attached BEFORE UPDATE FOR EACH ROW on every
-- table carrying updated_at (attached alongside each CREATE TABLE).
CREATE OR REPLACE FUNCTION public.touch_updated_at() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

-- §4.2 — human-reference sequences.
--
-- LD-0042 is global across every campaign and batch: it identifies a person,
-- and a person keeps one ref no matter how many campaigns they appear in.
-- CMP-01 is a plain campaign series. Both pad for sortability, and the pad is a
-- floor rather than a ceiling — LD-10000 is fine.
CREATE SEQUENCE IF NOT EXISTS public.lead_ref_seq     START 1;
CREATE SEQUENCE IF NOT EXISTS public.campaign_ref_seq START 1;

CREATE OR REPLACE FUNCTION public.next_lead_ref() RETURNS text
LANGUAGE sql
SET search_path = ''
AS $$ SELECT 'LD-'  || lpad(nextval('public.lead_ref_seq')::text, 4, '0') $$;

CREATE OR REPLACE FUNCTION public.next_campaign_ref() RETURNS text
LANGUAGE sql
SET search_path = ''
AS $$ SELECT 'CMP-' || lpad(nextval('public.campaign_ref_seq')::text, 2, '0') $$;

-- §4.3 — the dedupe key. Deterministic and immutable, so it can back a unique
-- index.
--
-- SUPERSEDED by 20260722131136_normalize_domain_host_only.sql. The version
-- below assumes only a host reaches it, which contradicted Tech.md §5.2 step 7
-- and would have keyed `https://acme.com/about-us` as `acme.com/about-us`. The
-- replacement reduces a full URL to its host itself. Left in place because it
-- is already applied; read the later migration for current behaviour.
--
-- Scope note: this produces the dedupe key ONLY. `www.` is stripped here and
-- deliberately not in the stored website_url, which keeps the URL the Admin
-- sees faithful to the CSV.
CREATE OR REPLACE FUNCTION public.normalize_domain(raw text) RETURNS text
LANGUAGE sql IMMUTABLE
SET search_path = ''
AS $$
  SELECT nullif(
    regexp_replace(
      regexp_replace(lower(btrim(raw)), '^https?://', ''),  -- strip scheme
      '^www\.', ''                                          -- strip www.
    ),
  '')
$$;

-- §4.4 — error bucketing.
--
-- IMMUTABLE is load-bearing, not decorative: campaign_leads.error_bucket is a
-- generated column over this function, and PostgreSQL only accepts immutable
-- expressions there. That is also what guarantees code and bucket can never
-- drift apart.
CREATE OR REPLACE FUNCTION public.error_code_bucket(code public.error_code)
RETURNS public.error_bucket
LANGUAGE sql IMMUTABLE
SET search_path = ''
AS $$
  SELECT CASE
    WHEN code IN ('dns_failure','connection_refused','ssl_error','http_4xx',
                  'http_5xx','parked_domain','empty_page','not_a_website')
      THEN 'bad_website'::public.error_bucket
    WHEN code IN ('bot_detected','captcha','geo_blocked','login_required','nav_timeout')
      THEN 'blocked'::public.error_bucket
    ELSE 'system'::public.error_bucket
  END
$$;
