-- Personalizer — 04/09 · core tables
-- Spec: docs/DB.md §5.1–5.4.
--
-- campaigns · import_batches · leads · campaign_leads
--
-- These four carry no foreign keys outside themselves (docs/DB.md §9.3), which
-- is what lets this file run in isolation against a database at the previous
-- step. Two columns here do point at asset tables — campaigns.intro_video_id
-- and the three asset references on campaign_leads — so the COLUMNS are
-- declared here and their FOREIGN KEY constraints are added by 05, once the
-- asset tables exist. Splitting the column from its constraint is the only way
-- to honour both the dependency order and the reference itself.

-- ---------------------------------------------------------------------------
-- §5.1 campaigns
-- ---------------------------------------------------------------------------
-- A named container: one intro video, one set of merge settings, one landing
-- template, one CTA. Import batches are assigned to a campaign.
CREATE TABLE IF NOT EXISTS public.campaigns (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ref              text NOT NULL DEFAULT public.next_campaign_ref(),
  name             text NOT NULL,
  slug             text NOT NULL,
  description      text,
  -- Null is the pause condition: jobs park at merge (§2.2).
  intro_video_id   uuid,
  merge_layout     public.merge_layout NOT NULL DEFAULT 'bubble_br',
  -- Bubble width as a fraction of frame width.
  pip_scale        numeric(4,3) NOT NULL DEFAULT 0.200,
  -- HTML with {{placeholders}}; see docs/DB.md §5.1.1.
  landing_template text NOT NULL,
  cta_type         text,
  cta_label        text,
  cta_url          text,
  -- Overrides of the global recorder defaults (settings.recorder.*).
  viewport_width   integer NOT NULL DEFAULT 1920,
  viewport_height  integer NOT NULL DEFAULT 1080,
  nav_timeout_ms   integer NOT NULL DEFAULT 120000,
  -- Hides from pickers; does not delete assets.
  archived_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT campaigns_ref_uk  UNIQUE (ref),
  CONSTRAINT campaigns_slug_uk UNIQUE (slug),
  CONSTRAINT campaigns_name_len_ck  CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  -- The slug is a URL segment: /{campaign-slug}/{lead-slug}.
  CONSTRAINT campaigns_slug_fmt_ck  CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  CONSTRAINT campaigns_pip_scale_ck CHECK (pip_scale BETWEEN 0.05 AND 0.60),
  CONSTRAINT campaigns_cta_type_ck  CHECK (cta_type IN ('calendar','website','email','phone','custom')),
  CONSTRAINT campaigns_nav_timeout_ck CHECK (nav_timeout_ms BETWEEN 10000 AND 600000)
);

CREATE OR REPLACE TRIGGER campaigns_touch_updated_at
  BEFORE UPDATE ON public.campaigns
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- §5.2 import_batches
-- ---------------------------------------------------------------------------
-- One CSV import. Immutable once complete — the audit record of what was
-- brought in and what was rejected.
CREATE TABLE IF NOT EXISTS public.import_batches (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id     uuid NOT NULL REFERENCES public.campaigns(id) ON DELETE CASCADE,
  filename        text NOT NULL,
  -- Storage path segment: /{batch}/…
  slug            text NOT NULL,
  row_count       integer NOT NULL DEFAULT 0,  -- data rows parsed, excluding the header
  imported_count  integer NOT NULL DEFAULT 0,  -- new leads created
  linked_count    integer NOT NULL DEFAULT 0,  -- existing leads linked to this campaign
  duplicate_count integer NOT NULL DEFAULT 0,  -- already in this campaign; ignored
  skipped_count   integer NOT NULL DEFAULT 0,  -- social-only / no usable website
  -- [{row: 14, reason: "ragged row: 7 fields, expected 9"}] — row numbers are
  -- 1-based INCLUDING the header, matching what the Admin sees in a text editor.
  rejected_rows   jsonb NOT NULL DEFAULT '[]'::jsonb,
  delimiter       text,                        -- auto-detected: , ; or \t
  had_bom         boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT import_batches_slug_uk UNIQUE (slug)
);

-- The four counts plus rejected rows must account for row_count. That is an
-- assertion for the importer's tests, not a CHECK — a partial import would
-- violate it mid-flight (docs/DB.md §5.2).

-- ---------------------------------------------------------------------------
-- §5.3 leads
-- ---------------------------------------------------------------------------
-- Pure identity and contact. No status, no assets, no campaign reference. If a
-- field would differ between two campaigns, it does not belong here.
CREATE TABLE IF NOT EXISTS public.leads (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ref             text NOT NULL DEFAULT public.next_lead_ref(),
  first_name      text,
  last_name       text,
  -- As given; not derived — CSVs disagree about name splitting.
  full_name       text,
  company         text,
  -- Case-insensitive by type, so dedupe needs no lower().
  email           extensions.citext,
  -- Stored as given. No normalization — formats are too varied to guess safely.
  phone           text,
  -- Normalized URL, `www.` retained (docs/Tech.md §5.2 step 6).
  website_url     text,
  -- normalize_domain(website_url), set by the importer. The dedupe key.
  domain          text,
  city            text,   -- feeds the lead slug
  state           text,
  country         text,
  industry        text,
  -- The batch that FIRST introduced this lead.
  source_batch_id uuid REFERENCES public.import_batches(id) ON DELETE SET NULL,
  -- The complete original CSV row, keyed by header. Lead Finder's columns
  -- drift; this is the escape hatch.
  raw             jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT leads_ref_uk UNIQUE (ref),
  -- A row with neither cannot be deduped or processed; it is rejected at import
  -- rather than stored.
  CONSTRAINT leads_identifiable_ck CHECK (domain IS NOT NULL OR email IS NOT NULL)
);

CREATE OR REPLACE TRIGGER leads_touch_updated_at
  BEFORE UPDATE ON public.leads
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- §5.4 campaign_leads — THE UNIT OF WORK
-- ---------------------------------------------------------------------------
-- One lead's participation in one campaign. Everything the pipeline reads and
-- writes lives here.
CREATE TABLE IF NOT EXISTS public.campaign_leads (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id     uuid NOT NULL REFERENCES public.campaigns(id) ON DELETE CASCADE,
  lead_id         uuid NOT NULL REFERENCES public.leads(id)     ON DELETE CASCADE,
  -- The batch that put the lead INTO THIS CAMPAIGN — may differ from
  -- leads.source_batch_id.
  batch_id        uuid REFERENCES public.import_batches(id) ON DELETE SET NULL,
  status          public.lead_status   NOT NULL DEFAULT 'queued',
  -- Where the job is, or where it stopped.
  current_step    public.pipeline_step NOT NULL DEFAULT 'recording',
  -- Lead slug: name+city, hash suffix only on collision. Unique within a campaign.
  slug            text NOT NULL,
  -- Full published URL. Set on successful deploy; cleared on unpublish.
  netlify_url     text,

  -- Asset references. FK constraints are added by migration 05 (see header).
  recording_id    uuid,
  video_id        uuid,
  landing_page_id uuid,

  -- Per-lead overrides. Null means inherit from the campaign (docs/Tech.md §14.2).
  merge_layout    public.merge_layout,
  pip_scale       numeric(4,3),

  -- Set on failure or pause; cleared when a retry starts.
  error_code      public.error_code,
  -- Generated so bucket filtering is a plain indexed predicate and the two
  -- fields can never drift (docs/DB.md §4.4).
  error_bucket    public.error_bucket
                    GENERATED ALWAYS AS (
                      CASE WHEN error_code IS NULL THEN NULL
                           ELSE public.error_code_bucket(error_code) END
                    ) STORED,
  -- Operator-readable message. The stack trace goes to logs.
  error_detail    text,
  -- Auto-retries consumed at current_step. Reset to 0 on a step transition or a
  -- manual retry.
  attempt_count   integer NOT NULL DEFAULT 0,

  queued_at       timestamptz,
  started_at      timestamptz,  -- first time a worker picked it up
  deployed_at     timestamptz,
  promoted_at     timestamptz,  -- deployed → ready
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  -- Once per campaign; the core rule.
  CONSTRAINT campaign_leads_campaign_lead_uk UNIQUE (campaign_id, lead_id),
  -- Backs the URL path.
  CONSTRAINT campaign_leads_campaign_slug_uk UNIQUE (campaign_id, slug),
  -- The retry cap itself is worker-side policy (docs/Tech.md §7.2) so raising
  -- it is a settings change, not a migration. This is a sanity bound against a
  -- runaway loop, nothing more.
  CONSTRAINT campaign_leads_attempts_ck CHECK (attempt_count >= 0 AND attempt_count <= 10),
  -- Cannot promote what is not live.
  CONSTRAINT campaign_leads_ready_url_ck    CHECK (status <> 'ready'    OR netlify_url IS NOT NULL),
  CONSTRAINT campaign_leads_deployed_url_ck CHECK (status <> 'deployed' OR netlify_url IS NOT NULL),
  -- A failure always explains itself.
  CONSTRAINT campaign_leads_failed_code_ck  CHECK (status <> 'failed'   OR error_code IS NOT NULL)
);

CREATE OR REPLACE TRIGGER campaign_leads_touch_updated_at
  BEFORE UPDATE ON public.campaign_leads
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
