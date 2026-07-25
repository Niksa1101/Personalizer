-- Phase 10 · poster_storage_key on videos (D8, D60)
-- Public poster URL is derived from this key — no poster_public_url column.

ALTER TABLE public.videos
  ADD COLUMN IF NOT EXISTS poster_storage_key text;

CREATE UNIQUE INDEX IF NOT EXISTS videos_poster_storage_key_uk
  ON public.videos (poster_storage_key)
  WHERE poster_storage_key IS NOT NULL;
