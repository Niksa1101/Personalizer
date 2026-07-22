-- Personalizer — 09/09 · storage bucket
-- Spec: docs/DB.md §8.
--
-- One bucket, public, holding ONLY the 720p web version of each final video.
-- Masters, raw recordings and intro videos never leave local disk.
--
-- Path convention: {uuid}/final.mp4 — a fresh UUID per video, deliberately NOT
-- videos.id or campaign_leads.id. Those appear in exports and the admin UI, and
-- reusing one would let anyone holding it enumerate the other.
--
-- The bucket is public because landing pages are static HTML on Netlify with no
-- session: a signed URL would either expire or require a token in the page
-- source, which is not meaningfully more private. Privacy comes from
-- unguessable paths plus noindex on the landing pages, not from access control.

INSERT INTO storage.buckets (id, name, public)
VALUES ('lead-videos', 'lead-videos', true)
ON CONFLICT (id) DO UPDATE SET public = true;

-- ---------------------------------------------------------------------------
-- NO SELECT POLICY ON storage.objects — deliberately. See docs/DB.md §8.1.
-- ---------------------------------------------------------------------------
-- DB.md §8 originally specified a `FOR SELECT TO anon, authenticated` policy
-- here. Measured against this project, that policy grants nothing the landing
-- pages need and breaks the very property §8 relies on:
--
--   * A public bucket serves /storage/v1/object/public/{bucket}/{path} without
--     consulting RLS at all. Verified: object GET 200 and Range GET 206 with no
--     key presented, which is exactly what a <video> element does.
--   * The policy's only real effect is to authorize the LIST endpoint. With it,
--     any holder of the anon key can enumerate every object in the bucket —
--     turning "privacy comes from unguessable paths" into paths that are handed
--     out on request. Verified: list returned the seeded object with the policy
--     present and [] without it.
--   * Uploads are unaffected either way; the worker uses the service role,
--     which bypasses RLS.
--
-- Since the anon key is deliberately shipped to a GitHub Action for the
-- keep-alive (docs/Tech.md §15), it lives outside our control surface, and
-- enumeration of every prospect's video is a real consequence rather than a
-- theoretical one.
--
-- The DROP is kept so this migration converges on the correct state whether or
-- not an earlier version of it created the policy.
DROP POLICY IF EXISTS "lead videos public read" ON storage.objects;
