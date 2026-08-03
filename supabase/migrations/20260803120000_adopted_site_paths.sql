-- Phase 18 · adopted_site_paths — durable, per-path operator adoption of files that
-- already existed on the Netlify site (docs/Tech.md §17 risk 9).
--
-- Per-path on purpose: adopting a whole site would disarm the guard forever, including
-- against foreign content that lands later.

CREATE TABLE IF NOT EXISTS public.adopted_site_paths (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id    text NOT NULL,
  path       text NOT NULL,
  adopted_at timestamptz NOT NULL DEFAULT now(),
  note       text,

  CONSTRAINT adopted_site_paths_site_path_uk UNIQUE (site_id, path),
  CONSTRAINT adopted_site_paths_path_ck CHECK (path LIKE '/%')
);

CREATE INDEX IF NOT EXISTS adopted_site_paths_site_idx
  ON public.adopted_site_paths (site_id);

ALTER TABLE public.adopted_site_paths ENABLE ROW LEVEL SECURITY;

-- No RLS policy — service_role only (docs/DB.md §7). Matches retained_pages.
