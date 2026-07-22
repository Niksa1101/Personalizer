-- Personalizer — 12 · normalize_domain() reduces a URL to its host
-- Spec: docs/DB.md §4.3, docs/Tech.md §5.2.
--
-- WHY
-- The original function stripped the scheme and `www.` and nothing else,
-- because DB.md §4.3 stated that "only the resulting host reaches this
-- function". Tech.md §5.2 step 7 told the importer the opposite — to call it
-- with the full website_url. Under that reading `https://acme.com/about-us`
-- produced the dedupe key `acme.com/about-us`, and the same business filed
-- under `/contact` would not have deduped against it. leads_domain_uk is a
-- UNIQUE index on the stored column, so the collision would have been silent:
-- two rows, two recordings, two landing pages, one business.
--
-- Nothing surfaced because the only caller so far is the seed, which passes
-- bare hosts. Phase 6 is the first real caller, and could have been written
-- exactly to spec and still been wrong.
--
-- Both layers are corrected rather than one: Tech.md §5.2 now says the importer
-- passes the host, AND the function no longer assumes it got one. The dedupe
-- key is the thing a hundred leads per batch are matched on; it should not
-- depend on a caller reading a scope note.
--
-- SAFE TO REPLACE
-- leads.domain is a plain column set by the importer, and leads_domain_uk
-- (20260720120600_indexes.sql:20) indexes that column, not this expression —
-- so there is no index to rebuild and no backfill to run. The three seeded
-- rows pass bare hosts and keep the keys they already have.
--
-- IMMUTABLE is retained and load-bearing: it is what allows the function to
-- back an index or generated column should a later phase want that.

CREATE OR REPLACE FUNCTION public.normalize_domain(raw text) RETURNS text
LANGUAGE sql IMMUTABLE
SET search_path = ''
AS $$
  SELECT nullif(
    regexp_replace(                                     -- 6. trailing dot: the
      regexp_replace(                                   --    root-label form
        regexp_replace(                                 --    `acme.com.`
          regexp_replace(
            regexp_replace(
              lower(btrim(raw)),
              -- 1. scheme and userinfo. The scheme is optional so that a
              --    protocol-relative `//acme.com/x` is handled too.
              '^(?:[a-z][a-z0-9+.-]*:)?//(?:[^/@]*@)?', ''
            ),
            '[/?#].*$', ''                              -- 2. path, query, fragment
          ),
          ':[0-9]+$', ''                                -- 3. port
        ),
        '^www\.', ''                                    -- 4. www.
      ),
      '\.$', ''                                         -- 5.
    ),
  '')
$$;

COMMENT ON FUNCTION public.normalize_domain(text) IS
  'Dedupe key: reduces a URL or host to a bare lowercase host. Strips scheme, '
  'userinfo, path/query/fragment, port, leading www. and a trailing root dot. '
  'Deliberately NOT applied to leads.website_url, which stays faithful to the '
  'CSV the operator imported (docs/DB.md §4.3).';
