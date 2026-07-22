-- Personalizer — 10/09 · the seed, as an idempotent function
-- Spec: docs/DB.md §10, docs/PRD.md §11 Phase 1 and AC-4.
--
-- WHY A FUNCTION RATHER THAN A PLAIN SCRIPT
-- DB.md §10 specifies seed.sql. Phase 1 also requires `npm run seed` to run it,
-- and scripts/seed.ts talks to Supabase over PostgREST with supabase-js — which
-- cannot execute raw SQL and has no database connection string among the eight
-- environment variables (Tech.md §14.1). Rather than maintain the seed twice,
-- once as SQL and once as a pile of JS upserts that would drift, the seed lives
-- here once and has two thin callers:
--
--   supabase/seed.sql  → SELECT public.seed_demo_data();   (supabase db reset)
--   scripts/seed.ts    → supabase.rpc('seed_demo_data')    (npm run seed)
--
-- Idempotent by construction: every insert is guarded, so a second run reports
-- zeroes and changes nothing. It returns a jsonb report so the caller can say
-- what it did instead of claiming success blindly.

CREATE OR REPLACE FUNCTION public.seed_demo_data() RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $fn$
DECLARE
  v_campaign_id       uuid;
  v_campaign_created  integer := 0;
  v_settings_inserted integer := 0;
  v_leads_inserted    integer := 0;
  v_links_inserted    integer := 0;
  v_events_inserted   integer := 0;
BEGIN
  -- -------------------------------------------------------------------------
  -- Settings defaults (§5.12) — every key, so the Settings screen is never
  -- empty. DO NOTHING rather than DO UPDATE: re-seeding must not silently
  -- revert a value the operator changed on the Settings screen.
  -- -------------------------------------------------------------------------
  INSERT INTO public.settings (key, value, description) VALUES
    ('recorder.viewport_width',    '1920',        'Browser width for website recording'),
    ('recorder.viewport_height',   '1080',        'Browser height for website recording'),
    ('recorder.nav_timeout_ms',    '120000',      'Give up loading a page after this long'),
    ('recorder.scroll_ease_ms',    '800',         'Ease-in/out ramp at each end of the scroll'),
    ('recorder.post_load_delay_ms','1500',        'Settle time after load before scrolling'),
    ('recorder.retention_days',    '30',          'Days to keep raw recordings before purging'),
    ('merge.pip_scale',            '0.20',        'Intro bubble width as a fraction of the frame'),
    ('merge.layout',               '"bubble_br"', 'Default picture-in-picture placement'),
    ('merge.max_stretch_factor',   '2.5',         'Above this, use the speed floor and hold instead'),
    ('encode.web_crf',             '28',          'x264 CRF for the 720p web version'),
    ('encode.web_audio_kbps',      '96',          'AAC bitrate for the 720p web version'),
    ('queue.concurrency',          '1',           'Simultaneous pipeline jobs (tested to 3)'),
    ('queue.auto_retry_limit',     '2',           'Automatic retries before a step is marked failed'),
    ('deploy.dry_run',             'false',       'Run the full pipeline but skip Netlify')
  ON CONFLICT (key) DO NOTHING;
  GET DIAGNOSTICS v_settings_inserted = ROW_COUNT;

  -- -------------------------------------------------------------------------
  -- Demo campaign. NO INTRO VIDEO, deliberately: this is the state that
  -- demonstrates the "Paused – Needs Intro" path, the single most common
  -- first-run surprise, and therefore worth seeding rather than avoiding.
  --
  -- WHERE NOT EXISTS rather than ON CONFLICT DO NOTHING so a re-run does not
  -- burn a value from campaign_ref_seq — the next real campaign should be
  -- CMP-02, not CMP-05 because the seed ran four times.
  -- -------------------------------------------------------------------------
  INSERT INTO public.campaigns (
    name, slug, description, landing_template, cta_type, cta_label, cta_url
  )
  SELECT
    'Demo Campaign',
    'demo',
    'Seeded example. Assign an intro video to unpause its jobs.',
    $html$<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<!-- These pages name individual businesses and must not be indexed
     (docs/Tech.md §10.2), reinforced by a site-level robots.txt Disallow: / -->
<meta name="robots" content="noindex, nofollow">
<title>A quick look at {{company}}</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 24px 20px 48px;
    font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    background: #fafaf9;
    color: #1c1917;
  }
  main { max-width: 640px; margin: 0 auto; }
  .eyebrow {
    margin: 0 0 8px;
    font-size: 13px;
    letter-spacing: .08em;
    text-transform: uppercase;
    color: #78716c;
  }
  h1 { margin: 0 0 12px; font-size: 28px; line-height: 1.25; font-weight: 650; }
  .lede { margin: 0 0 24px; font-size: 17px; color: #44403c; }
  .player {
    margin: 0 0 28px;
    border-radius: 14px;
    overflow: hidden;
    background: #1c1917;
    box-shadow: 0 1px 2px rgba(0,0,0,.06), 0 8px 24px rgba(0,0,0,.10);
  }
  /* preload="metadata" renders the first frame as the still. There is no
     remote poster because the poster frame is a local-only artifact
     (docs/DB.md §5.7) and the bucket holds the video alone. */
  video { display: block; width: 100%; height: auto; background: #1c1917; }
  .cta {
    display: block;
    padding: 15px 24px;
    border-radius: 10px;
    background: #1c1917;
    color: #fafaf9;
    font-size: 17px;
    font-weight: 600;
    text-align: center;
    text-decoration: none;
  }
  .cta:hover { background: #292524; }
  footer { margin: 32px 0 0; font-size: 14px; color: #78716c; }
  footer a { color: inherit; }
  @media (min-width: 640px) {
    body { padding: 56px 24px; }
    h1 { font-size: 34px; }
  }
  @media (prefers-color-scheme: dark) {
    body { background: #1c1917; color: #fafaf9; }
    .lede { color: #d6d3d1; }
    .eyebrow, footer { color: #a8a29e; }
    .cta { background: #fafaf9; color: #1c1917; }
    .cta:hover { background: #e7e5e4; }
  }
</style>
</head>
<body>
<main>
  <p class="eyebrow">{{ref}}</p>
  <h1>A quick look at {{company}}</h1>
  <p class="lede">I recorded a short walk-through of {{website_url}} with a note from me over the top. About a minute, no sign-up.</p>

  <div class="player">
    <video controls playsinline preload="metadata">
      <source src="{{video_url}}" type="video/mp4">
      Your browser cannot play this video.
    </video>
  </div>

  <a class="cta" href="{{cta_url}}">{{cta_label}}</a>

  <footer>
    <p>Made for {{company}} — {{city}} {{state}}</p>
  </footer>
</main>
</body>
</html>$html$,
    'calendar',
    'Book a 15-minute call',
    'https://example.com/book'
  WHERE NOT EXISTS (SELECT 1 FROM public.campaigns WHERE slug = 'demo');
  GET DIAGNOSTICS v_campaign_created = ROW_COUNT;

  SELECT id INTO v_campaign_id FROM public.campaigns WHERE slug = 'demo';

  -- -------------------------------------------------------------------------
  -- Three demo leads, against stable public sites that record well.
  --
  -- No email addresses: these are real organizations, and inventing a contact
  -- at one would put a fake person into a table that feeds outreach exports.
  -- Domain-only is also the honest demo — it exercises the domain-only dedupe
  -- path of §6.1, and leaves {{email}} rendering empty, which demonstrates
  -- that a missing value never blocks a deploy (§5.1.1).
  -- -------------------------------------------------------------------------
  INSERT INTO public.leads (company, website_url, domain, city, state, country, industry, raw)
  SELECT d.company, d.website_url, public.normalize_domain(d.website_url),
         d.city, d.state, d.country, d.industry,
         jsonb_build_object('seed', true)
  FROM (VALUES
    ('Mozilla Foundation',       'https://www.mozilla.org', 'Mountain View', 'CA', 'US', 'Software'),
    ('Wikimedia Foundation',     'https://www.wikipedia.org', 'San Francisco', 'CA', 'US', 'Nonprofit'),
    ('Free Software Foundation', 'https://www.gnu.org',     'Boston',        'MA', 'US', 'Nonprofit')
  ) AS d(company, website_url, city, state, country, industry)
  WHERE NOT EXISTS (
    SELECT 1 FROM public.leads l WHERE l.domain = public.normalize_domain(d.website_url)
  );
  GET DIAGNOSTICS v_leads_inserted = ROW_COUNT;

  -- -------------------------------------------------------------------------
  -- Link them into the demo campaign at exactly the state a real import
  -- reaches when no intro is assigned: recording has notionally completed and
  -- is campaign-agnostic, so the job parks at merge rather than at the start.
  -- intro_missing is the one error code that accompanies a PAUSE rather than a
  -- failure — recorded so the dashboard can explain the pause without a
  -- special case (§2.4).
  -- -------------------------------------------------------------------------
  INSERT INTO public.campaign_leads (
    campaign_id, lead_id, slug, status, current_step, error_code, error_detail, queued_at
  )
  SELECT
    v_campaign_id,
    l.id,
    -- name+city, lowercased, non-alphanumerics collapsed to a single dash
    -- (docs/Tech.md §10.1). No collision hashing needed for three fixed rows.
    btrim(regexp_replace(lower(l.company || '-' || l.city), '[^a-z0-9]+', '-', 'g'), '-'),
    'paused',
    'merge',
    'intro_missing',
    'Campaign has no intro video. Assign one to resume from the merge step.',
    now()
  FROM public.leads l
  WHERE l.domain IN ('mozilla.org', 'wikipedia.org', 'gnu.org')
    AND NOT EXISTS (
      SELECT 1 FROM public.campaign_leads cl
      WHERE cl.campaign_id = v_campaign_id AND cl.lead_id = l.id
    );
  GET DIAGNOSTICS v_links_inserted = ROW_COUNT;

  -- A timeline, so the lead drawer demonstrates itself rather than showing an
  -- empty panel on a fresh clone.
  INSERT INTO public.pipeline_events (campaign_lead_id, kind, step, message, error_code, meta)
  SELECT cl.id, e.kind, e.step, e.message, e.error_code, jsonb_build_object('seed', true)
  FROM public.campaign_leads cl
  CROSS JOIN (VALUES
    ('imported'::public.event_kind, NULL::public.pipeline_step,
     'Imported from the seeded demo data.', NULL::public.error_code),
    ('paused'::public.event_kind,   'merge'::public.pipeline_step,
     'Paused before merge: this campaign has no intro video assigned.',
     'intro_missing'::public.error_code)
  ) AS e(kind, step, message, error_code)
  WHERE cl.campaign_id = v_campaign_id
    AND NOT EXISTS (
      SELECT 1 FROM public.pipeline_events pe WHERE pe.campaign_lead_id = cl.id
    );
  GET DIAGNOSTICS v_events_inserted = ROW_COUNT;

  RETURN jsonb_build_object(
    'settings_inserted',  v_settings_inserted,
    'campaign_created',   (v_campaign_created > 0),
    'campaign_id',        v_campaign_id,
    'leads_inserted',     v_leads_inserted,
    'campaign_leads_inserted', v_links_inserted,
    'events_inserted',    v_events_inserted
  );
END $fn$;

-- The function reads and writes every table in the schema. PostgreSQL grants
-- EXECUTE to PUBLIC by default, which would hand a leaked anon key a way to
-- write rows that RLS otherwise forbids. Revoke first, then grant only to the
-- roles that are already trusted with the whole database.
REVOKE ALL ON FUNCTION public.seed_demo_data() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.seed_demo_data() TO service_role;
