-- Personalizer — 05/09 · asset tables
-- Spec: docs/DB.md §5.5–5.8.
--
-- recordings · intro_videos · videos · landing_pages
--
-- All local paths are stored relative to LOCAL_STORAGE_ROOT, POSIX separators,
-- no leading slash (docs/DB.md §3). The root is env config and must never be
-- baked into a row — moving the media directory is an env change, not a
-- migration.
--
-- This file also closes the four forward references left open by migration 04.

-- ---------------------------------------------------------------------------
-- §5.6 intro_videos — created first: videos and campaigns both point at it.
-- ---------------------------------------------------------------------------
-- Admin-uploaded talking-head clips, normalized on upload to 1080p / 30fps /
-- AAC 48kHz. THE INTRO IS THE MASTER CLOCK — its duration determines the length
-- of every final video built from it (docs/Tech.md §9.1).
CREATE TABLE IF NOT EXISTS public.intro_videos (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name              text NOT NULL,
  -- Normalized file: intros/{id}.mp4
  local_path        text NOT NULL,
  original_filename text,
  -- Probed and cached AT UPLOAD. Read on every merge; never re-probed per job.
  duration_ms       integer NOT NULL,
  width             integer NOT NULL DEFAULT 1920,   -- post-normalization
  height            integer NOT NULL DEFAULT 1080,
  fps               numeric(5,2) NOT NULL DEFAULT 30.00,
  file_size_bytes   bigint,
  poster_path       text,   -- extracted frame, used as the UI thumbnail
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT intro_videos_duration_ck CHECK (duration_ms > 0)
);

CREATE OR REPLACE TRIGGER intro_videos_touch_updated_at
  BEFORE UPDATE ON public.intro_videos
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- §5.5 recordings
-- ---------------------------------------------------------------------------
-- Campaign-agnostic Playwright capture. Recorded once per LEAD and reused
-- across every campaign that lead appears in — which is why a second campaign
-- against the same list costs merge-and-deploy instead of a full re-crawl.
-- Raw files are purged after 30 days.
CREATE TABLE IF NOT EXISTS public.recordings (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id                 uuid NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
  -- {batch}/{lead-slug}/recording.mp4. Null once purged.
  local_path              text,
  duration_ms             integer,   -- probed after capture; drives the stretch math
  width                   integer,
  height                  integer,
  -- Full document height; explains scroll duration.
  page_height_px          integer,
  file_size_bytes         bigint,
  screenshot_before_path  text,      -- debug: first paint
  screenshot_after_path   text,      -- debug: end of scroll
  recorded_at             timestamptz,  -- start of the successful capture
  -- Set by the retention job; local_path is nulled at the same time.
  purged_at               timestamptz,
  -- Set when the capture itself failed.
  error_code              public.error_code,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE TRIGGER recordings_touch_updated_at
  BEFORE UPDATE ON public.recordings
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- Partial, not plain: at most ONE USABLE recording per lead, while purged and
-- failed rows remain as history. A forced re-record sets purged_at on the
-- current row before inserting, so the index never blocks the operation.
CREATE UNIQUE INDEX IF NOT EXISTS recordings_lead_active_uk
  ON public.recordings (lead_id)
  WHERE purged_at IS NULL AND error_code IS NULL;

-- ---------------------------------------------------------------------------
-- §5.7 videos
-- ---------------------------------------------------------------------------
-- The merged output for one campaign_lead. Two artifacts: a 1080p master kept
-- locally, and a 720p web version uploaded to Supabase Storage.
CREATE TABLE IF NOT EXISTS public.videos (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_lead_id  uuid NOT NULL REFERENCES public.campaign_leads(id) ON DELETE CASCADE,
  -- Which intro this was built from — kept for provenance after the intro is
  -- replaced or deleted.
  intro_video_id    uuid REFERENCES public.intro_videos(id) ON DELETE SET NULL,
  -- 1080p local master: {batch}/{lead-slug}/final.mp4
  master_path       text,
  -- 720p local copy: {batch}/{lead-slug}/web.mp4. Deleted after a successful
  -- upload + deploy; the Supabase copy is canonical from then on.
  web_path          text,
  -- Supabase Storage object key: {uuid}/final.mp4 — a fresh UUID, deliberately
  -- unrelated to any id that appears in an export or the admin UI (§8).
  web_storage_key   text,
  -- Full public URL; substituted into {{video_url}}.
  web_public_url    text,
  duration_ms       integer,        -- equals the intro's duration by construction
  -- setpts multiplier applied to the recording. 1.0 = untouched.
  stretch_factor    numeric(6,3),
  -- True when the ~2.5x cap was hit and the fallback applied: floor the scroll
  -- speed and hold the final frame.
  used_speed_floor  boolean NOT NULL DEFAULT false,
  master_size_bytes bigint,
  web_size_bytes    bigint,
  poster_path       text,           -- landing-page poster frame (local)
  encoded_at        timestamptz,
  uploaded_at       timestamptz,    -- web version reached Supabase Storage
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT videos_campaign_lead_uk UNIQUE (campaign_lead_id),
  CONSTRAINT videos_web_storage_key_uk UNIQUE (web_storage_key)
);

-- stretch_factor and used_speed_floor are stored rather than recomputed because
-- they explain a video's pacing after the fact — the most common "why does this
-- one look wrong?" question, and unanswerable from the file alone.

CREATE OR REPLACE TRIGGER videos_touch_updated_at
  BEFORE UPDATE ON public.videos
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- §5.8 landing_pages
-- ---------------------------------------------------------------------------
-- The generated HTML and its deployment state. One per campaign_lead.
CREATE TABLE IF NOT EXISTS public.landing_pages (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_lead_id  uuid NOT NULL REFERENCES public.campaign_leads(id) ON DELETE CASCADE,
  -- Site-relative: /{campaign-slug}/{lead-slug}
  path              text NOT NULL,
  -- Rendered output. Stored so a redeploy needs no regeneration and diffs are
  -- inspectable.
  html              text,
  -- SHA-1 of html — the digest Netlify's file-digest API matches against, and
  -- therefore what governs whether a page is re-uploaded at all. Not a security
  -- choice: it is the algorithm the API requires.
  content_sha1      text,
  deploy_status     public.deploy_status NOT NULL DEFAULT 'pending',
  -- For log correlation in the Netlify dashboard.
  netlify_deploy_id text,
  deployed_at       timestamptz,
  unpublished_at    timestamptz,   -- set when removed from the site
  error_detail      text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT landing_pages_campaign_lead_uk UNIQUE (campaign_lead_id),
  CONSTRAINT landing_pages_path_uk UNIQUE (path),
  CONSTRAINT landing_pages_sha1_ck CHECK (content_sha1 ~ '^[0-9a-f]{40}$')
);

CREATE OR REPLACE TRIGGER landing_pages_touch_updated_at
  BEFORE UPDATE ON public.landing_pages
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Deferred foreign keys from migration 04
-- ---------------------------------------------------------------------------
-- ALTER TABLE ... ADD CONSTRAINT has no IF NOT EXISTS, so each is guarded by a
-- duplicate_object handler to keep the file re-runnable (docs/DB.md §9.2).
DO $$ BEGIN
  ALTER TABLE public.campaigns
    ADD CONSTRAINT campaigns_intro_video_fk
    FOREIGN KEY (intro_video_id) REFERENCES public.intro_videos(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Deleting an intro sets campaigns.intro_video_id to null, which re-pauses that
-- campaign's unprocessed jobs at merge. Already-merged videos are unaffected;
-- they are finished files.

DO $$ BEGIN
  ALTER TABLE public.campaign_leads
    ADD CONSTRAINT campaign_leads_recording_fk
    FOREIGN KEY (recording_id) REFERENCES public.recordings(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE public.campaign_leads
    ADD CONSTRAINT campaign_leads_video_fk
    FOREIGN KEY (video_id) REFERENCES public.videos(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE public.campaign_leads
    ADD CONSTRAINT campaign_leads_landing_page_fk
    FOREIGN KEY (landing_page_id) REFERENCES public.landing_pages(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
