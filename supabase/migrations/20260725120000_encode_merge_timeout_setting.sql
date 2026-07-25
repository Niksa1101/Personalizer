-- Phase 9 (merge) added a fifteenth setting key: encode.merge_timeout_ms.
--
-- lib/settings.ts falls back to SETTING_DEFAULTS when a key has no row, so the
-- merge step works without this insert — but it warns on every resolve, and the
-- Settings screen (PRD §6.8) enumerates the table, so an unseeded key is a
-- setting the operator cannot see or tune. DB.md §5.12 lists it.
--
-- Forward-only per DB.md §9.2: 20260720120900_seed_function.sql is already
-- applied and must not be edited in place. seed_demo_data() still lists the
-- original fourteen; it does not need this key added, because migrations always
-- run before the seed and its INSERT is ON CONFLICT DO NOTHING — by the time
-- the function runs, this row exists. Anyone adding a *sixteenth* key should
-- add it to the function, not follow this pattern.

INSERT INTO public.settings (key, value, description) VALUES
  (
    'encode.merge_timeout_ms',
    '1800000',
    'Give up on a merge or web-encode FFmpeg run after this long'
  )
ON CONFLICT (key) DO NOTHING;
