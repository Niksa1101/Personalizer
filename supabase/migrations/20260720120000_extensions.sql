-- Personalizer — 01/09 · extensions
-- Spec: docs/DB.md §3.
--
-- Both extensions live in the `extensions` schema, which is Supabase's
-- convention and is on the default search_path for every database role. Every
-- reference to `citext` in later migrations is schema-qualified anyway, so the
-- schema choice cannot bite a migration that runs with a narrowed search_path.
--
-- pgcrypto is enabled because DB.md §3 calls for it. Note that gen_random_uuid()
-- has been in core PostgreSQL since 13, so the extension is belt-and-braces
-- rather than load-bearing.

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS citext   WITH SCHEMA extensions;
