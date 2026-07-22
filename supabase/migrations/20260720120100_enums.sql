-- Personalizer — 02/09 · enums
-- Spec: docs/DB.md §2.
--
-- CREATE TYPE has no IF NOT EXISTS, so each type is wrapped in a DO block that
-- swallows duplicate_object. That is what makes this file re-runnable after a
-- partially applied push (docs/DB.md §9.2).
--
-- Forward-only: values are added with ALTER TYPE ... ADD VALUE in their own
-- migration file, never removed and never renamed.

-- §2.1 — coarse dashboard state.
DO $$ BEGIN
  CREATE TYPE lead_status AS ENUM (
    'queued',      -- accepted, waiting for a worker
    'processing',  -- a worker holds it; see current_step
    'paused',      -- blocked on an Admin action (today: missing intro video)
    'deployed',    -- landing page is live but unreviewed
    'ready',       -- Admin reviewed and promoted; safe to hand to outreach
    'failed',      -- terminal after auto-retries exhausted
    'skipped'      -- excluded at import (e.g. social-only URL, no website)
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- §2.2 — fine position within processing. Order is fixed.
DO $$ BEGIN
  CREATE TYPE pipeline_step AS ENUM (
    'recording',  -- Playwright captures the lead's website
    'merge',      -- FFmpeg composites intro + recording (PiP)
    'page',       -- landing page HTML is generated
    'deploy'      -- Netlify digest deploy
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- §2.3 — whose problem is this?
DO $$ BEGIN
  CREATE TYPE error_bucket AS ENUM (
    'bad_website',  -- the lead's site is the problem; usually terminal
    'blocked',      -- the site actively refused us; may succeed on retry
    'system'        -- our side broke; retry is expected to help
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- §2.4 — granular codes. Each maps to exactly one bucket via
-- error_code_bucket() (§4.4); the UI shows a label, the database stores a code.
DO $$ BEGIN
  CREATE TYPE error_code AS ENUM (
    -- bad_website
    'dns_failure',          -- domain does not resolve
    'connection_refused',
    'ssl_error',
    'http_4xx',             -- 404, 410 — page is gone
    'http_5xx',             -- origin is broken
    'parked_domain',        -- resolves to a registrar placeholder
    'empty_page',           -- loaded, but no meaningful content to scroll
    'not_a_website',        -- social profile or directory listing only
    -- blocked
    'bot_detected',         -- challenge page / interstitial
    'captcha',
    'geo_blocked',
    'login_required',
    'nav_timeout',          -- exceeded the configurable load timeout
    -- system
    'browser_crash',
    'ffmpeg_failure',
    'intro_missing',        -- paired with status='paused', not 'failed'
    'missing_asset',        -- expected local file is gone (purged or moved)
    'storage_upload_failed',
    'netlify_failure',
    'disk_full',
    'unknown'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- §2.5
DO $$ BEGIN
  CREATE TYPE deploy_status AS ENUM (
    'pending',   -- manifest built, not yet sent
    'uploading', -- Netlify has requested files by digest; we are pushing them
    'live',
    'failed',
    'removed'    -- landing page deliberately unpublished
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- §2.6 — picture-in-picture placement of the intro overlay.
DO $$ BEGIN
  CREATE TYPE merge_layout AS ENUM (
    'bubble_br',  -- circular, bottom-right (default)
    'bubble_bl',
    'bubble_tr',
    'bubble_tl',
    'rect_br',    -- rectangular thumbnail, bottom-right
    'fullscreen_intro' -- intro plays full-frame, recording follows (no overlay)
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- §2.7 — state of one worker attempt at one step.
DO $$ BEGIN
  CREATE TYPE job_state AS ENUM (
    'running',
    'succeeded',
    'failed',
    'interrupted'  -- worker died mid-step; recovered on next boot
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- §2.8
DO $$ BEGIN
  CREATE TYPE event_kind AS ENUM (
    'imported', 'queued', 'step_started', 'step_succeeded', 'step_failed',
    'retry_scheduled', 'paused', 'resumed', 'interrupted',
    'deployed', 'promoted', 'unpublished', 'note'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- §2.9
DO $$ BEGIN
  CREATE TYPE log_level AS ENUM ('debug', 'info', 'warn', 'error');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
