# Personalizer — Database Specification

**Status:** Draft 2 — authoritative for schema, and **applied**. Companion documents: `docs/Tech.md`, `docs/PRD.md`.
**Engine:** PostgreSQL **17** (Supabase managed). Accessed **server-side only** with the service role key.

> **Implemented on 2026-07-21** (`PRD.md` §11 Phase 1). Every section below is live in the Supabase project named *Personalizer*, applied as the first ten migrations of §9.1. Two things changed during implementation and the text now reflects the implementation, not the draft:
>
> 1. **§8 no longer creates a `SELECT` policy on `storage.objects`.** The drafted policy did not enable public playback — it enabled bucket *listing*, which defeated §8's own privacy argument. Measured, then removed. See §8.1.
> 2. **The seed is a function, not a loose script.** `seed.sql` and `npm run seed` are two thin callers of one idempotent `seed_demo_data()`. See §10.1.
>
> The engine is PostgreSQL 17, not the 15 originally assumed. Nothing in this schema depended on the difference; the version is corrected here rather than silently.

> **Two migrations were added and applied on 2026-07-22** after the Phase 0–2 review (§9.1): `20260722131125_default_privileges.sql` (§7.1.2) and `20260722131136_normalize_domain_host_only.sql` (§4.3). Verified live afterwards: `pg_default_acl` for `public` now lists only `postgres` and `service_role`; `anon` holds `EXECUTE` on none of the seven public functions; `heartbeat` `INSERT` still succeeds, so the keep-alive is intact; and the three seeded domains are unchanged, so the `normalize_domain()` replacement needed no backfill.

> **Supersedes the original brief.** Three decisions here override earlier assumptions and must not be re-derived from the brief:
> 1. A lead is **not** globally single-use. It may be processed once **per campaign**, producing separate assets and URLs.
> 2. `campaign_leads` — not `leads` — is the **unit of work**. It carries status, current step, slug, published URL and asset references. `leads` is a pure identity/contact record.
> 3. Video and page assets are **local-first**. Only the 720p web version lands in Supabase Storage; the database stores paths, not blobs.

---

## 1. ER diagram

```
                          ┌──────────────────┐
                          │   intro_videos   │
                          │  (normalized     │
                          │   1080p/30/AAC)  │
                          └────────┬─────────┘
                                   │ 0..1
                                   ▼
┌──────────────────┐      ┌──────────────────┐      ┌──────────────────┐
│  import_batches  │─────▶│    campaigns     │◀─────│    settings      │
│  (a CSV import)  │ N..1 │  CMP-01, slug,   │      │ (global defaults;│
└────────┬─────────┘      │  merge + CTA cfg │      │  campaigns hold  │
         │                └────────┬─────────┘      │  the overrides)  │
         │ 1..N                    │ 1..N           └──────────────────┘
         │                         │
         ▼                         ▼
┌──────────────────┐      ┌────────────────────────┐
│      leads       │─────▶│    campaign_leads      │  ◀── THE UNIT OF WORK
│  LD-0042         │ 1..N │  status, current_step, │
│  identity only:  │      │  slug, netlify_url,    │
│  name, email,    │      │  error_code, attempts  │
│  domain, city…   │      └───────┬────────────────┘
└────────┬─────────┘              │
         │ 1..N                   ├── 0..1 ─▶ ┌──────────────┐
         ▼                        │           │   videos     │ (master + web)
┌──────────────────┐              │           └──────────────┘
│   recordings     │              ├── 0..1 ─▶ ┌──────────────┐
│ campaign-agnostic│              │           │landing_pages │
│ reused, 30d TTL  │              │           └──────────────┘
└──────────────────┘              │
                                  ├── 1..N ─▶ ┌──────────────┐
                                  │           │  job_runs    │
                                  │           └──────────────┘
                                  └── 1..N ─▶ ┌──────────────┐
                                              │pipeline_events│ (timeline)
                                              └──────────────┘

  ┌──────────┐   ┌─────────────┐
  │   logs   │   │  heartbeat  │  (keep-alive; insert-only anon key)
  └──────────┘   └─────────────┘
```

**Reading the diagram.** `recordings` hangs off `leads`, not off `campaign_leads` — a website is recorded once and reused across every campaign that lead appears in. Everything downstream of the recording (merge, page, deploy) is per-campaign and therefore hangs off `campaign_leads`.

---

## 2. Enums

All enums are native PostgreSQL types. Adding a value is a forward-only migration (`ALTER TYPE … ADD VALUE`); values are never removed or renamed once shipped.

### 2.1 `lead_status`

The coarse state shown in the dashboard's status column and filter chips.

```sql
CREATE TYPE lead_status AS ENUM (
  'queued',      -- accepted, waiting for a worker
  'processing',  -- a worker holds it; see current_step
  'paused',      -- blocked on an Admin action (today: missing intro video)
  'deployed',    -- landing page is live but unreviewed
  'ready',       -- Admin reviewed and promoted; safe to hand to outreach
  'failed',      -- terminal after auto-retries exhausted
  'skipped'      -- excluded at import (e.g. social-only URL, no website)
);
```

`deployed` → `ready` is the only transition an Admin performs by hand, and it is bulk-approvable. Nothing downstream reads `deployed`; the CSV export ships `ready` rows only.

### 2.2 `pipeline_step`

The fine-grained position within processing. Meaningful whenever `status` is `processing`, `paused` or `failed`; it records where the job *is*, or where it *stopped*.

```sql
CREATE TYPE pipeline_step AS ENUM (
  'recording',  -- Playwright captures the lead's website
  'merge',      -- FFmpeg composites intro + recording (PiP)
  'page',       -- landing page HTML is generated
  'deploy'      -- Netlify digest deploy
);
```

Step order is fixed: `recording → merge → page → deploy`. Retry resumes from the stored `current_step`; a forced full restart resets it to `recording`.

A campaign without an intro video parks its jobs at `status='paused'`, `current_step='merge'` — recording has completed and is campaign-agnostic, so it is never wasted work.

### 2.3 `error_bucket`

Coarse grouping used for dashboard filtering and for deciding whether a failure is the Admin's problem or the system's.

```sql
CREATE TYPE error_bucket AS ENUM (
  'bad_website',  -- the lead's site is the problem; usually terminal, data fix needed
  'blocked',      -- the site actively refused us; may succeed on retry
  'system'        -- our side broke; retry is expected to help
);
```

### 2.4 `error_code`

Granular codes. Each maps to exactly one bucket via `error_code_bucket()` (§4.4). The UI shows the human label; the database stores the code.

```sql
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
```

`intro_missing` is the one code that accompanies a *pause* rather than a failure — it is recorded so the dashboard can explain the pause without a special case.

### 2.5 `deploy_status`

```sql
CREATE TYPE deploy_status AS ENUM (
  'pending',   -- manifest built, not yet sent
  'uploading', -- Netlify has requested files by digest; we are pushing them
  'live',
  'failed',
  'removed'    -- reserved: deliberate per-page unpublish (Phase 13 UI; mechanism ships Phase 11 via manifest omission)
);
```

`removed` is outside `MANIFEST_DEPLOY_STATUSES` (`pending`, `uploading`, `live`, `failed`), so a page in that state is omitted from the manifest — that omission *is* the unpublish. The deploy step therefore treats `removed` as a **stale** page: asking to deploy a lead whose page is unpublished republishes it (`upsertLandingPage` revives the row to `pending`), and the step fails loudly if the trigger lead's page is somehow still absent from the manifest. Without that, the lead would deploy "successfully" while never reaching `status='deployed'`.

### 2.6 `merge_layout`

Picture-in-picture placement for the intro overlay. Default `bubble_br` — a circular bubble, bottom-right, ~20% of frame width.

```sql
CREATE TYPE merge_layout AS ENUM (
  'bubble_br',  -- circular, bottom-right (default)
  'bubble_bl',
  'bubble_tr',
  'bubble_tl',
  'rect_br',    -- rectangular thumbnail, bottom-right
  'fullscreen_intro' -- intro plays full-frame, recording follows (no overlay)
);
```

### 2.7 `job_state`

Terminal-ish state of one worker attempt at one step. Distinct from `lead_status`: a `campaign_leads` row has one status, but many `job_runs`.

```sql
CREATE TYPE job_state AS ENUM (
  'running',
  'succeeded',
  'failed',
  'interrupted'  -- worker died mid-step; recovered on next boot
);
```

### 2.8 `event_kind`

```sql
CREATE TYPE event_kind AS ENUM (
  'imported', 'queued', 'step_started', 'step_succeeded', 'step_failed',
  'retry_scheduled', 'paused', 'resumed', 'interrupted',
  'deployed', 'promoted', 'unpublished', 'note'
);
```

`note` carries free-text system annotations that are not state changes — for example "raw recording had been purged; re-recorded automatically".

### 2.9 `log_level`

```sql
CREATE TYPE log_level AS ENUM ('debug', 'info', 'warn', 'error');
```

---

## 3. Conventions

These apply to every table unless a column spec says otherwise.

| Concern | Rule |
|---|---|
| Primary key | `id uuid PRIMARY KEY DEFAULT gen_random_uuid()` |
| Human reference | Separate `ref` column, generated from a sequence. Never the PK. |
| Timestamps | `timestamptz`, stored **UTC**. Display-local conversion is the UI's job. |
| Audit columns | `created_at timestamptz NOT NULL DEFAULT now()`; `updated_at` where rows mutate, maintained by the `touch_updated_at()` trigger (§4.1). |
| Deletes | Real deletes, with explicit `ON DELETE` behavior per FK. No soft-delete flags — this is a single-operator tool and orphaned rows cost more than they save. |
| Text | `text`, never `varchar(n)`. Length limits are `CHECK` constraints where they matter. |
| Paths | Local filesystem paths are stored **relative to `LOCAL_STORAGE_ROOT`**, POSIX separators, no leading slash. The root is env config and must not be baked into rows. |
| Money/durations | Durations in **milliseconds**, `integer`. No floats for time. |
| JSON | `jsonb`, never `json`. Every `jsonb` column has a documented shape in this file. |

`pgcrypto` must be enabled for `gen_random_uuid()`:

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;  -- case-insensitive email
```

---

## 4. Functions and triggers

### 4.1 `touch_updated_at()`

```sql
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;
```

Attached as `BEFORE UPDATE FOR EACH ROW` on every table carrying `updated_at`. Eight tables have one: `campaigns`, `leads`, `campaign_leads`, `recordings`, `intro_videos`, `videos`, `landing_pages`, `settings`.

Implementation notes, both deliberate:

- The function pins `SET search_path = ''`, as do all five functions in this section. They are invoked from triggers and generated columns that run under whatever `search_path` the caller happens to carry, so every non-`pg_catalog` reference in their bodies is schema-qualified. This is hardening against a hostile or merely careless `search_path`, not style.
- `now()` is `transaction_timestamp()`, so **two updates inside one transaction produce the same `updated_at`**. That is correct for this application — every mutation is its own transaction — but it does mean a test that inserts and then updates within a single transaction will observe an unchanged `updated_at` and look like a trigger failure. It is not one. Use `clock_timestamp()` only if sub-transaction ordering ever becomes meaningful, which it currently is not.

### 4.2 Human-ref sequences

```sql
CREATE SEQUENCE lead_ref_seq     START 1;
CREATE SEQUENCE campaign_ref_seq START 1;

CREATE OR REPLACE FUNCTION next_lead_ref() RETURNS text
LANGUAGE sql AS $$
  WITH n AS (SELECT nextval('lead_ref_seq') AS v)
  SELECT 'LD-'  || lpad(n.v::text, greatest(4, length(n.v::text)), '0') FROM n
$$;

CREATE OR REPLACE FUNCTION next_campaign_ref() RETURNS text
LANGUAGE sql AS $$
  WITH n AS (SELECT nextval('campaign_ref_seq') AS v)
  SELECT 'CMP-' || lpad(n.v::text, greatest(2, length(n.v::text)), '0') FROM n
$$;
```

`LD-0042` is **global** across all campaigns and batches — it identifies a person, and a person keeps one ref no matter how many campaigns they appear in. `CMP-01` is a plain campaign series. Both pad for sortability and both overflow gracefully (`LD-10000` is fine; the pad is a floor, not a ceiling).

> **Correction landed during Phase 12 verification** (`20260726170000_ref_padding_no_truncate.sql`). The paragraph above stated the intent; the SQL did not implement it. **`lpad()` truncates on the right when its input is longer than the target width** — it is not padding-only. So the pad was a *ceiling*, exactly what the text denies: `lpad('10000', 4, '0')` is `'1000'`, and `LD-10000` collided with lead #1000. Campaigns were worse, at width 2: past 99 every value in a decade collapsed to the same two characters (`100`→`10`, `117`→`11`, `118`→`11`), so at most one INSERT per decade could succeed and the rest failed on `campaigns_ref_uk`. Found live with `campaign_ref_seq` at 117 — campaign creation was already broken.
>
> `greatest(<width>, length(v))` removes the cliff rather than moving it: `lpad` still zero-pads short values to the historical shape and becomes a no-op once the number outgrows the width. Refs below the boundary are byte-identical (`CMP-01`, `LD-0001`), so no backfill was needed — and none was possible to get wrong, since no row generated above a boundary had survived. `nextval()` is captured in a CTE because referencing it twice in the expression would burn two sequence values per ref.
>
> The lesson for §9.2's forward-only rule: a check that only exercises values *below* a padding boundary proves nothing about the boundary. Phase 1 verified both sequences and still missed this.
>
> `npm run verify:schema` now pins it. It samples twelve consecutive refs from each generator rather than a pair, because a truncating generator repeats itself for a whole decade — one pair would only catch it when it happened to straddle a boundary, and a check that passes nine runs in ten is worse than none. The same leg catches `nextval()` being evaluated twice per ref (gaps of 2), which is why the generators capture it in a CTE. Each run consumes twelve values per sequence.

### 4.3 Domain normalization

The dedupe key. Deterministic and immutable, so it can back a unique index.

The function reduces a URL **or** a bare host to a bare lowercase host, in this order: strip scheme and userinfo → cut at the first `/`, `?` or `#` → strip `:port` → strip leading `www.` → strip a trailing root dot → `nullif('')`. See `20260722131136_normalize_domain_host_only.sql` for the implementation.

Scope note: this function produces the **dedupe key only**. `www.` is stripped here and *not* in the stored `website_url`, which keeps the URL the Admin actually sees faithful to the CSV. Full URL normalization — tracking-parameter stripping, scheme defaulting — happens in application code at import time and is specified in `Tech.md` §5.2.

> **Correction landed after review.** The original version stripped `^https?://` and `^www\.` and nothing else, on the stated assumption that "only the resulting host reaches this function". `Tech.md` §5.2 step 7 said the opposite — pass the full `website_url` — so `https://acme.com/about-us` would have produced the dedupe key `acme.com/about-us`, and the same business under `/contact` would not have deduped against it. Because `leads_domain_uk` indexes the stored column rather than this expression, the collision would have been silent: two rows, two recordings, two landing pages, one business.
>
> Nothing surfaced because the only caller so far is the seed, which passes bare hosts; Phase 6 is the first real caller and could have been written exactly to spec and still been wrong. **Both** layers were corrected — `Tech.md` §5.2 now says the importer passes the host, and the function no longer assumes it got one. The dedupe key is what a hundred leads per batch are matched on; it should not depend on a caller having read a scope note.

### 4.4 Error bucketing

```sql
CREATE OR REPLACE FUNCTION error_code_bucket(code error_code) RETURNS error_bucket
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN code IN ('dns_failure','connection_refused','ssl_error','http_4xx',
                  'http_5xx','parked_domain','empty_page','not_a_website')
      THEN 'bad_website'::error_bucket
    WHEN code IN ('bot_detected','captcha','geo_blocked','login_required','nav_timeout')
      THEN 'blocked'::error_bucket
    ELSE 'system'::error_bucket
  END
$$;
```

`campaign_leads.error_bucket` is a **generated column** over this function, so bucket filtering is a plain indexed predicate and the two fields can never drift.

---

## 5. Tables

### 5.1 `campaigns`

A named container: one intro video, one set of merge settings, one landing template, one CTA. Import batches are assigned to a campaign.

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK |
| `ref` | `text` | no | `next_campaign_ref()` | `CMP-01`. Unique. |
| `name` | `text` | no | — | Admin-facing. `CHECK (length(btrim(name)) BETWEEN 1 AND 120)` |
| `slug` | `text` | no | — | URL segment: `/{campaign-slug}/{lead-slug}`. Unique. `CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$')` |
| `description` | `text` | yes | — | |
| `intro_video_id` | `uuid` | yes | — | FK → `intro_videos(id)` `ON DELETE SET NULL`. **Null is the pause condition**: jobs park at `merge`. |
| `merge_layout` | `merge_layout` | no | `'bubble_br'` | Campaign-level default; a lead may override. |
| `pip_scale` | `numeric(4,3)` | no | `0.200` | Bubble width as a fraction of frame width. `CHECK (pip_scale BETWEEN 0.05 AND 0.60)` |
| `landing_template` | `text` | no | — | HTML with `{{placeholders}}`. See §5.1.1. |
| `cta_type` | `text` | yes | — | `CHECK (cta_type IN ('calendar','website','email','phone','custom'))` |
| `cta_label` | `text` | yes | — | Button text. |
| `cta_url` | `text` | yes | — | Substituted into `{{cta_url}}`. |
| `viewport_width` | `integer` | no | `1920` | Override of the global recorder default. |
| `viewport_height` | `integer` | no | `1080` | |
| `nav_timeout_ms` | `integer` | no | `120000` | `CHECK (nav_timeout_ms BETWEEN 10000 AND 600000)` |
| `archived_at` | `timestamptz` | yes | — | Hides from pickers; does not delete assets. |
| `created_at` | `timestamptz` | no | `now()` | |
| `updated_at` | `timestamptz` | no | `now()` | trigger |

Deleting a campaign cascades to its `campaign_leads` and their per-campaign assets. It does **not** delete `leads` or `recordings` — those are shared. The published landing pages are external to the database; the UI prompts "also remove the published landing pages?" and, if confirmed, the worker issues an unpublish deploy before the row is removed. That prompt is a product requirement (`PRD.md`), not a database constraint — the schema cannot enforce it.

#### 5.1.1 `landing_template` placeholders

Every `leads` column is exposed by name, plus two computed values:

| Placeholder | Source |
|---|---|
| `{{first_name}}` `{{last_name}}` `{{full_name}}` | `leads` |
| `{{company}}` `{{city}}` `{{state}}` `{{country}}` | `leads` |
| `{{email}}` `{{phone}}` `{{website_url}}` `{{industry}}` | `leads` |
| `{{ref}}` | `leads.ref` (`LD-0042`) |
| `{{video_url}}` | `videos.web_public_url` — the Supabase public URL |
| `{{poster_url}}` | Derived from `videos.poster_storage_key` — the public URL of the uploaded poster JPEG beside the video. Empty when no poster has been uploaded; the generator strips an empty `poster=""` and downgrades `preload="none"` → `preload="metadata"`. |
| `{{cta_url}}` `{{cta_label}}` | `campaigns` |

Unknown placeholders render empty rather than erroring; missing values must not block a deploy.

---

### 5.2 `import_batches`

One CSV import. Immutable once complete — the audit record of what was brought in and what was rejected.

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK |
| `campaign_id` | `uuid` | no | — | FK → `campaigns(id)` `ON DELETE CASCADE` |
| `filename` | `text` | no | — | As uploaded. |
| `slug` | `text` | no | — | Storage path segment (`/{batch}/…`). Unique. |
| `row_count` | `integer` | no | `0` | Data rows parsed, excluding the header. |
| `imported_count` | `integer` | no | `0` | New `leads` created. |
| `linked_count` | `integer` | no | `0` | Existing leads linked to this campaign. |
| `duplicate_count` | `integer` | no | `0` | Already in this campaign; ignored. |
| `skipped_count` | `integer` | no | `0` | Social-only / no usable website. |
| `rejected_rows` | `jsonb` | no | `'[]'` | `[{row: 14, reason: "ragged row: 7 fields, expected 9"}]` — row numbers are 1-based including the header, matching what the Admin sees in a text editor. |
| `delimiter` | `text` | yes | — | Auto-detected: `,` `;` or `\t`. Recorded for support. |
| `had_bom` | `boolean` | no | `false` | |
| `exists_list` | `jsonb` | no | `'[]'` | Persisted *already exists in campaign X* list (`PRD.md` §6.6); populated for linked rows. |
| `created_at` | `timestamptz` | no | `now()` | |

The four counts plus rejected rows must account for `row_count`; a mismatch is a bug and worth an assertion in tests, not a database constraint (partial imports would violate it mid-flight).

---

### 5.3 `leads`

Pure identity and contact. **No status, no assets, no campaign reference.** If a field would differ between two campaigns, it does not belong here.

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK |
| `ref` | `text` | no | `next_lead_ref()` | `LD-0042`, global. Unique. |
| `first_name` | `text` | yes | — | |
| `last_name` | `text` | yes | — | |
| `full_name` | `text` | yes | — | As given; not derived, CSVs disagree about name splitting. |
| `company` | `text` | yes | — | |
| `email` | `citext` | yes | — | Case-insensitive by type, so dedupe needs no `lower()`. |
| `phone` | `text` | yes | — | Stored as given. No normalization — formats are too varied to guess safely. |
| `website_url` | `text` | yes | — | Normalized URL, `www.` **retained**. |
| `domain` | `text` | yes | — | `normalize_domain(website_url)`, set by the importer. The dedupe key. |
| `city` | `text` | yes | — | Feeds the lead slug. |
| `state` | `text` | yes | — | |
| `country` | `text` | yes | — | |
| `industry` | `text` | yes | — | |
| `source_batch_id` | `uuid` | yes | — | FK → `import_batches(id)` `ON DELETE SET NULL`. The batch that *first* introduced this lead. |
| `raw` | `jsonb` | no | `'{}'` | The complete original CSV row, keyed by header. Lead Finder's columns drift; this is the escape hatch. |
| `created_at` | `timestamptz` | no | `now()` | |
| `updated_at` | `timestamptz` | no | `now()` | trigger |

`leads_identifiable_ck` — `CHECK (domain IS NOT NULL OR email IS NOT NULL)`. A row with neither cannot be deduped or processed, and is rejected at import instead of stored.

**It is an edit-path guard too, and that is the path operators actually meet it on.** Clearing a lead's website URL in the drawer nulls `domain` (the column is derived from the URL, never entered directly), so on a lead whose URL is its *only* identifier the save is refused with `23514`. `updateLead` translates that into "A lead needs a website URL or an email address — clearing both leaves nothing to dedupe on." The remedy has to name those two columns: earlier copy offered "a company name", which does not appear in the constraint at all and sent the operator to a field that could never clear the error (`PRD.md` Phase 13 finding 18). If this predicate is ever widened, that message is the thing to update with it — `verify:leads-ui` asserts both sides (cleared when an email exists; refused with usable copy when it does not).

Deleting a lead cascades to its `campaign_leads`, `recordings` and, through those, to `videos` and `landing_pages`.

---

### 5.4 `campaign_leads` — the unit of work

One lead's participation in one campaign. Everything the pipeline reads and writes lives here.

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK |
| `campaign_id` | `uuid` | no | — | FK → `campaigns(id)` `ON DELETE CASCADE` |
| `lead_id` | `uuid` | no | — | FK → `leads(id)` `ON DELETE CASCADE` |
| `batch_id` | `uuid` | yes | — | FK → `import_batches(id)` `ON DELETE SET NULL`. The batch that put the lead *into this campaign* — may differ from `leads.source_batch_id`. |
| `status` | `lead_status` | no | `'queued'` | |
| `current_step` | `pipeline_step` | no | `'recording'` | Where the job is, or where it stopped. |
| `slug` | `text` | no | — | Lead slug: name+city, hash suffix only on collision. Unique **within a campaign**. |
| `netlify_url` | `text` | yes | — | Full published URL. Set on successful deploy; **retained on unpublish** (unpublish is a `landing_pages.deploy_status` change only — see §2.5). |
| `recording_id` | `uuid` | yes | — | FK → `recordings(id)` `ON DELETE SET NULL`. The recording this campaign's video was built from. |
| `video_id` | `uuid` | yes | — | FK → `videos(id)` `ON DELETE SET NULL` |
| `landing_page_id` | `uuid` | yes | — | FK → `landing_pages(id)` `ON DELETE SET NULL` |
| `merge_layout` | `merge_layout` | yes | — | Per-lead override. Null ⇒ inherit from campaign. |
| `pip_scale` | `numeric(4,3)` | yes | — | Per-lead override. Null ⇒ inherit. |
| `error_code` | `error_code` | yes | — | Set on failure or pause; cleared when a retry starts. |
| `error_bucket` | `error_bucket` | yes | **generated** | `GENERATED ALWAYS AS (CASE WHEN error_code IS NULL THEN NULL ELSE error_code_bucket(error_code) END) STORED` |
| `error_detail` | `text` | yes | — | Operator-readable message. The stack trace goes to `logs`. |
| `attempt_count` | `integer` | no | `0` | Auto-retries consumed at `current_step`. Reset to 0 on a step transition or a manual retry. |
| `queued_at` | `timestamptz` | yes | — | |
| `started_at` | `timestamptz` | yes | — | First time a worker picked it up. |
| `deployed_at` | `timestamptz` | yes | — | |
| `deployed_dry_run` | `boolean` | no | `false` | Set when `settings.deploy.dry_run` completes the pipeline without a real Netlify URL. Cleared on the next live deploy. |
| `promoted_at` | `timestamptz` | yes | — | `deployed` → `ready`. |
| `created_at` | `timestamptz` | no | `now()` | |
| `updated_at` | `timestamptz` | no | `now()` | trigger |

Constraints:

```sql
UNIQUE (campaign_id, lead_id)            -- once per campaign; the core rule
UNIQUE (campaign_id, slug)               -- backs the URL path
CHECK  (attempt_count >= 0 AND attempt_count <= 10)
CHECK  (status <> 'ready'    OR netlify_url IS NOT NULL)   -- can't promote what isn't live
CHECK  (status <> 'deployed' OR netlify_url IS NOT NULL OR deployed_dry_run)
CHECK  (status <> 'failed'   OR error_code IS NOT NULL)    -- a failure always explains itself
```

The auto-retry rule — twice, then `failed` — is enforced by the worker, not by a constraint: the cap belongs to a configurable policy, and a `CHECK` would make raising it a migration. The `<= 10` check is a sanity bound against runaway loops.

Interrupted jobs are recovered by the worker at boot from `status='processing'` with no live BullMQ job; recovery resumes at `current_step` and writes an `interrupted` event. See `Tech.md` §7.

---

### 5.5 `recordings`

Campaign-agnostic Playwright capture. Recorded once per lead, reused everywhere. Raw files are purged after 30 days.

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK |
| `lead_id` | `uuid` | no | — | FK → `leads(id)` `ON DELETE CASCADE` |
| `local_path` | `text` | yes | — | Relative to `LOCAL_STORAGE_ROOT`: `{batch}/{lead-slug}/recording.mp4`. Null once purged. |
| `duration_ms` | `integer` | yes | — | Probed after capture. Drives the time-stretch math. |
| `width` | `integer` | yes | — | |
| `height` | `integer` | yes | — | |
| `page_height_px` | `integer` | yes | — | Full document height; explains scroll duration. |
| `file_size_bytes` | `bigint` | yes | — | |
| `screenshot_before_path` | `text` | yes | — | Debug: first paint. |
| `screenshot_after_path` | `text` | yes | — | Debug: end of scroll. |
| `recorded_at` | `timestamptz` | yes | — | Start of the successful capture. |
| `purged_at` | `timestamptz` | yes | — | Set by the retention job; `local_path` is nulled at the same time. |
| `error_code` | `error_code` | yes | — | Set when the capture itself failed. |
| `created_at` | `timestamptz` | no | `now()` | |
| `updated_at` | `timestamptz` | no | `now()` | trigger |

```sql
CREATE UNIQUE INDEX recordings_lead_active_uk
  ON recordings (lead_id)
  WHERE purged_at IS NULL AND error_code IS NULL;
```

A partial unique index, not a plain one: at most **one usable** recording per lead, while purged and failed rows remain as history. A forced re-record purges the current row (setting `purged_at`) before inserting, so the index never blocks the operation.

If a step needs a recording whose `local_path` is null, the worker silently re-records and writes a `note` event — the Admin sees an explanation on the timeline but is not asked to do anything. A file that is missing *without* `purged_at` set is a different situation: that is `missing_asset`, and the Admin is offered a re-record.

---

### 5.6 `intro_videos`

Admin-uploaded talking-head clips, normalized on upload to 1080p / 30fps / AAC 48kHz. **The intro is the master clock** — its duration determines the length of every final video built from it.

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK |
| `name` | `text` | no | — | Admin-facing label. |
| `local_path` | `text` | no | — | Normalized file, relative to `LOCAL_STORAGE_ROOT`: `intros/{id}.mp4`. |
| `original_filename` | `text` | yes | — | |
| `duration_ms` | `integer` | no | — | **Probed and cached at upload.** Read on every merge; never re-probed per job. `CHECK (duration_ms > 0)` |
| `width` | `integer` | no | `1920` | Post-normalization. |
| `height` | `integer` | no | `1080` | |
| `fps` | `numeric(5,2)` | no | `30.00` | |
| `file_size_bytes` | `bigint` | yes | — | |
| `poster_path` | `text` | yes | — | Extracted frame, used as the UI thumbnail. |
| `created_at` | `timestamptz` | no | `now()` | |
| `updated_at` | `timestamptz` | no | `now()` | trigger |

Uploads arrive through a **Route Handler**, not a Server Action — Server Actions cap request bodies at 1MB. See `Tech.md` §4.

Deleting an intro sets `campaigns.intro_video_id` to null, which re-pauses that campaign's unprocessed jobs at `merge`. Already-merged videos are unaffected; they are finished files.

---

### 5.7 `videos`

The merged output for one `campaign_lead`. Two artifacts: a 1080p master kept locally, and a 720p web version uploaded to Supabase Storage.

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK |
| `campaign_lead_id` | `uuid` | no | — | FK → `campaign_leads(id)` `ON DELETE CASCADE`. Unique. |
| `intro_video_id` | `uuid` | yes | — | FK → `intro_videos(id)` `ON DELETE SET NULL`. Which intro this was built from — kept for provenance after the intro is replaced. |
| `master_path` | `text` | yes | — | 1080p local master: `{batch}/{lead-slug}/final.mp4` |
| `web_path` | `text` | yes | — | 720p local copy: `{batch}/{lead-slug}/web.mp4`. Deleted after successful upload + deploy. |
| `web_storage_key` | `text` | yes | — | Supabase Storage object key: `{uuid}/final.mp4` (unguessable). Unique. |
| `web_public_url` | `text` | yes | — | Full public URL; substituted into `{{video_url}}`. |
| `duration_ms` | `integer` | yes | — | Equals the intro's duration by construction. |
| `stretch_factor` | `numeric(6,3)` | yes | — | `setpts` multiplier applied to the recording. `1.0` = untouched. |
| `used_speed_floor` | `boolean` | no | `false` | True when the ~2.5× cap was hit and the fallback applied: floor the scroll speed and hold at the bottom. |
| `master_size_bytes` | `bigint` | yes | — | |
| `web_size_bytes` | `bigint` | yes | — | |
| `poster_path` | `text` | yes | — | Landing-page poster frame (local). Kept indefinitely as the admin thumbnail. |
| `poster_storage_key` | `text` | yes | — | Supabase Storage object key: `{video prefix}/poster.jpg`. Unique. No separate `poster_public_url` column — the URL is derived at generation time, same as the video key pattern but one fewer column that can disagree. |
| `encoded_at` | `timestamptz` | yes | — | |
| `uploaded_at` | `timestamptz` | yes | — | Web version reached Supabase Storage. |
| `created_at` | `timestamptz` | no | `now()` | |
| `updated_at` | `timestamptz` | no | `now()` | trigger |

`stretch_factor` and `used_speed_floor` are stored rather than recomputed because they explain a video's pacing after the fact — the most common "why does this one look wrong?" question, and unanswerable from the file alone.

---

### 5.8 `landing_pages`

The generated HTML and its deployment state. One per `campaign_lead`.

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK |
| `campaign_lead_id` | `uuid` | no | — | FK → `campaign_leads(id)` `ON DELETE CASCADE`. Unique. |
| `path` | `text` | no | — | Site-relative: `/{campaign-slug}/{lead-slug}`. Unique. |
| `html` | `text` | yes | — | Rendered output. Stored so a redeploy needs no regeneration and diffs are inspectable. |
| `content_sha1` | `text` | yes | — | SHA-1 of `html` — the digest Netlify's file-digest API matches against. `CHECK (content_sha1 ~ '^[0-9a-f]{40}$')` |
| `deploy_status` | `deploy_status` | no | `'pending'` | |
| `netlify_deploy_id` | `text` | yes | — | For log correlation in the Netlify dashboard. |
| `deployed_at` | `timestamptz` | yes | — | |
| `unpublished_at` | `timestamptz` | yes | — | Set when removed from the site. |
| `error_detail` | `text` | yes | — | |
| `created_at` | `timestamptz` | no | `now()` | |
| `updated_at` | `timestamptz` | no | `now()` | trigger |

SHA-1 is not a security choice — it is the algorithm Netlify's digest API requires.

The deploy sends a **full manifest** every time; Netlify responds with only the digests it lacks and we upload just those. `content_sha1` therefore governs whether a given page is re-uploaded at all.

When regenerated HTML differs (`content_sha1` changes) or the site-relative `path` changes (slug rename), `deploy_status` resets to `'pending'` and `unpublished_at` clears — a previously `live` page must redeploy before Netlify serves the new bytes. A regeneration where both `content_sha1` and `path` are unchanged touches nothing (including `deploy_status`).

**Deploy state transitions (Phase 11):** rows in the manifest with `deploy_status ∈ {pending, uploading, live, failed}` are included; `removed` is excluded until Phase 13 sets it deliberately. On a successful deploy, every manifest path → `live` with `deployed_at` and `netlify_deploy_id`; paths in `required` pass through `uploading` first. Failed deploys set `failed` + truncated `error_detail`. Dry-run leaves `deploy_status='pending'` on the page row while the lead reaches `deployed` with `deployed_dry_run=true`.

---

### 5.9 `job_runs`

One worker attempt at one step. The retry and timing record.

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK |
| `campaign_lead_id` | `uuid` | no | — | FK → `campaign_leads(id)` `ON DELETE CASCADE` |
| `step` | `pipeline_step` | no | — | |
| `state` | `job_state` | no | `'running'` | |
| `attempt` | `integer` | no | `1` | 1-based within this step. `CHECK (attempt >= 1)` |
| `queue_job_id` | `text` | yes | — | BullMQ job id, for cross-referencing worker logs. |
| `worker_id` | `text` | yes | — | Host + PID. Matters once concurrency > 1. |
| `error_code` | `error_code` | yes | — | |
| `error_detail` | `text` | yes | — | |
| `started_at` | `timestamptz` | no | `now()` | |
| `finished_at` | `timestamptz` | yes | — | Null while running, or forever if the worker was killed and boot recovery marked it `interrupted`. |
| `duration_ms` | `integer` | yes | **generated** | `GENERATED ALWAYS AS (EXTRACT(epoch FROM (finished_at - started_at)) * 1000)::integer STORED` |

```sql
CREATE INDEX job_runs_lead_step_idx ON job_runs (campaign_lead_id, step, started_at DESC);
CREATE INDEX job_runs_running_idx   ON job_runs (started_at) WHERE state = 'running';
```

The partial index on running jobs is what boot recovery scans — it stays tiny regardless of history size.

---

### 5.10 `pipeline_events`

The append-only timeline shown in the lead detail drawer. Never updated, never deleted except by cascade.

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `bigint` | no | identity | PK. Monotonic ordering matters more than opacity here. |
| `campaign_lead_id` | `uuid` | no | — | FK → `campaign_leads(id)` `ON DELETE CASCADE` |
| `kind` | `event_kind` | no | — | |
| `step` | `pipeline_step` | yes | — | Null for events that aren't step-scoped (`imported`, `promoted`). |
| `message` | `text` | no | — | Operator-readable, written for the drawer. |
| `error_code` | `error_code` | yes | — | |
| `meta` | `jsonb` | no | `'{}'` | Structured extras: `{attempt: 2, duration_ms: 8412, stretch_factor: 1.8}` |
| `created_at` | `timestamptz` | no | `now()` | |

```sql
CREATE INDEX pipeline_events_lead_idx ON pipeline_events (campaign_lead_id, created_at DESC, id DESC);
```

`id DESC` is a tiebreaker: several events can share a timestamp within a fast step, and the drawer must order them deterministically.

This table is the Supabase Realtime subscription target for live dashboard updates.

---

### 5.11 `logs`

System-wide structured logging. Not per-lead — that is `pipeline_events`. This is where stack traces, FFmpeg stderr and Netlify responses go.

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `bigint` | no | identity | PK |
| `level` | `log_level` | no | `'info'` | |
| `scope` | `text` | no | — | `importer` / `recorder` / `merger` / `deployer` / `web` / `worker` |
| `message` | `text` | no | — | |
| `campaign_lead_id` | `uuid` | yes | — | FK → `campaign_leads(id)` `ON DELETE SET NULL`. Nullable — logs outlive their subject. |
| `job_run_id` | `uuid` | yes | — | FK → `job_runs(id)` `ON DELETE SET NULL` |
| `meta` | `jsonb` | no | `'{}'` | |
| `created_at` | `timestamptz` | no | `now()` | |

```sql
CREATE INDEX logs_created_idx ON logs (created_at DESC);
CREATE INDEX logs_level_idx   ON logs (level, created_at DESC) WHERE level IN ('warn','error');
```

`ON DELETE SET NULL` rather than cascade is deliberate: deleting a lead should not erase the record of what the system did.

---

### 5.12 `settings`

Global defaults, single-row-per-key. Campaign-level and lead-level overrides live on their own tables (§5.1, §5.4); this is the bottom of the resolution chain.

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `key` | `text` | no | — | PK |
| `value` | `jsonb` | no | — | Typed by key. |
| `description` | `text` | yes | — | Rendered as help text on the Settings screen. |
| `updated_at` | `timestamptz` | no | `now()` | trigger |

Seeded keys:

| Key | Default | Meaning |
|---|---|---|
| `recorder.viewport_width` | `1920` | |
| `recorder.viewport_height` | `1080` | |
| `recorder.nav_timeout_ms` | `120000` | |
| `recorder.scroll_ease_ms` | `800` | Ease-in / ease-out ramp at each end of the constant-velocity scroll. |
| `recorder.post_load_delay_ms` | `1500` | After network idle + lazy-image forcing + font wait. |
| `recorder.retention_days` | `30` | Raw recording TTL. |
| `merge.pip_scale` | `0.20` | |
| `merge.layout` | `"bubble_br"` | |
| `merge.max_stretch_factor` | `2.5` | Above this, fall back to speed floor + hold. |
| `encode.web_crf` | `28` | |
| `encode.web_audio_kbps` | `96` | |
| `encode.merge_timeout_ms` | `1800000` | 30 min. Kill deadline for a merge or web-encode FFmpeg run. Added in Phase 9 by `20260725120000_encode_merge_timeout_setting.sql`, not by `seed_demo_data()` — see the note below. |
| `queue.concurrency` | `1` | Tested to 3. |
| `queue.auto_retry_limit` | `2` | Then `failed`. |
| `deploy.dry_run` | `false` | Skips Netlify entirely; everything else runs. |
| `deploy.timeout_ms` | `300000` | Whole-deploy budget (lock wait + upload + poll). Added in Phase 11 by `20260726130200_deploy_timeout_setting.sql`. |

Sixteen keys. Fourteen come from `seed_demo_data()` (§10); `encode.merge_timeout_ms` and `deploy.timeout_ms` are each inserted by their own migration instead, because §9.2 is forward-only and the seed function was already applied. The distinction is invisible in practice — migrations always run before the seed, and the function's `INSERT … ON CONFLICT (key) DO NOTHING` no-ops on a key that already exists — so every path yields the same sixteen rows. **A seventeenth key should go in the seed function, not follow this pattern.**

`lib/settings.ts` carries a `SETTING_DEFAULTS` fallback for every key and warns when one is missing from the table, so an unseeded key degrades to its default rather than breaking the pipeline. It would, however, be invisible to the Settings screen (`PRD.md` §6.8), which enumerates this table.

Resolution order for any overlapping value: **lead override → campaign value → `settings` default**. Nulls mean "inherit", which is why the override columns in §5.4 are nullable rather than defaulted.

---

### 5.13 `heartbeat`

Keeps the Supabase project from being paused for inactivity. Written by a daily GitHub Actions cron.

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `bigint` | no | identity | PK |
| `source` | `text` | no | `'github-action'` | |
| `created_at` | `timestamptz` | no | `now()` | |

This is the **only** table reachable by a non-service key. The cron uses a narrowly scoped **insert-only anon key**; the service role key must never enter GitHub secrets, because a leaked service key is unrestricted access to every table above. See §7.3.

Because the key has **no** `SELECT`, the insert must not ask for the row back. PostgREST has defaulted to `Prefer: return=minimal` on `POST` since v9, so the `Tech.md` §15 `curl` succeeds as written (verified: `201`), but the header is now sent explicitly there rather than relied upon.

A weekly `DELETE FROM heartbeat WHERE created_at < now() - interval '90 days'` keeps it bounded — run from the same action, or left alone, since the row is tiny.

---

### 5.14 `retained_pages`

Snapshot of live landing pages kept after a campaign delete when the operator unchecks "Also remove the published landing page(s)". Rows are unioned into the Netlify manifest so the URL stays live after the source `landing_pages` and `campaign_leads` rows are gone.

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK |
| `path` | `text` | no | — | Site-relative path (same as `landing_pages.path`). Unique. |
| `html` | `text` | no | — | Snapshot at retain time |
| `content_sha1` | `text` | no | — | `CHECK (content_sha1 ~ '^[0-9a-f]{40}$')` |
| `retained_at` | `timestamptz` | no | `now()` | |
| `reason` | `text` | yes | — | e.g. `campaign_delete_retain` |
| `lead_ref` | `text` | yes | — | Denormalized — source lead row is gone |
| `campaign_ref` | `text` | yes | — | Denormalized — used by slug-lock (`firstDeployLocked`) |

```sql
CREATE INDEX retained_pages_campaign_ref_idx ON retained_pages (campaign_ref);
```

RLS enabled, no policy — service-role only. Populated by `snapshot_live_pages()`; `ON CONFLICT (path) DO UPDATE` for retained-vs-retained collision. A live `landing_pages` row at the same path wins on deploy (D32) and the retained row is deleted.

**Snapshot scope** covers `deploy_status IN ('pending','uploading','live','failed')` with non-null `html`/`content_sha1` — the manifest-eligible set, not `live` alone. A page's row status lags the site: a campaign mid-deploy is genuinely published on Netlify while its rows still read `pending`. Retaining only `live` rows silently 404'd pages the operator had asked to keep.

### 5.15 `pending_site_sync`

Durable record that the Netlify site is behind the database. Written **inside the same transaction** as the change that caused it, which is the whole point: Redis was previously the only record, so a Redis outage during a campaign delete stranded published pages with their source rows already gone (`Tech.md` §10.3).

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK |
| `reason` | `text` | no | — | `campaign_delete`, `campaign_slug_change` |
| `requested_at` | `timestamptz` | no | `now()` | Drain watermark |
| `meta` | `jsonb` | yes | — | Campaign id/ref, retain flag, moved-page count |

```sql
CREATE INDEX pending_site_sync_requested_at_idx ON pending_site_sync (requested_at);
```

RLS enabled, no policy — service-role only. Written by `delete_campaign_retaining_pages()`, `delete_lead_retaining_pages()`, `unpublish_landing_page()`, and `update_campaign_general()`. Drained by `runSiteSync` after a clean pass, deleting only rows with `requested_at <= ` the instant that pass read the manifest — a marker written *during* a sync describes a change that sync did not see. Boot recovery and the 60 s periodic reconcile enqueue a `site-sync` whenever any row exists.

**Verified end to end** in the Phase 11 artifact (ii) run: both campaign deletes were issued as raw RPC calls with no Redis enqueue, so the reconcile had to find the markers unaided. It did, synced, and cleared them. Note the dirty flag is *transient* — `runSiteSyncPass` clears it before assembling — so polling `pz:deploy:dirty:*` is not a reliable way to observe a pending sync; query this table instead.

---

## 6. Indexes

Primary keys and the unique constraints named inline above are omitted here.

```sql
-- Dedupe: global, on normalized domain OR email.
-- Partial, because the majority of leads have one identifier but not both.
CREATE UNIQUE INDEX leads_domain_uk ON leads (domain) WHERE domain IS NOT NULL;
CREATE UNIQUE INDEX leads_email_uk  ON leads (email)  WHERE email  IS NOT NULL;

-- Dashboard: campaign-scoped status filtering, plus the "All campaigns" view.
CREATE INDEX campaign_leads_campaign_status_idx ON campaign_leads (campaign_id, status, created_at DESC);
CREATE INDEX campaign_leads_status_idx          ON campaign_leads (status, created_at DESC);
CREATE INDEX campaign_leads_bucket_idx          ON campaign_leads (error_bucket) WHERE error_bucket IS NOT NULL;
CREATE INDEX campaign_leads_lead_idx            ON campaign_leads (lead_id);
CREATE INDEX campaign_leads_batch_idx           ON campaign_leads (batch_id);

-- Worker: claim queued work, and find orphans at boot.
CREATE INDEX campaign_leads_queued_idx     ON campaign_leads (created_at)  WHERE status = 'queued';
CREATE INDEX campaign_leads_processing_idx ON campaign_leads (started_at)  WHERE status = 'processing';

-- Retention sweep.
CREATE INDEX recordings_purge_idx ON recordings (recorded_at) WHERE purged_at IS NULL AND local_path IS NOT NULL;

-- Deploy manifest assembly.
CREATE INDEX landing_pages_deploy_status_idx ON landing_pages (deploy_status);
```

### 6.1 The dedupe strategy, stated plainly

Dedupe is **global**, not per-campaign, and matches on normalized domain **or** email. Two unique partial indexes rather than one composite: a composite `(domain, email)` would treat `(acme.com, NULL)` and `(acme.com, jo@acme.com)` as distinct, which is exactly the collision we need to catch.

The importer therefore checks both keys before inserting. On a hit it does **not** silently merge and does not reject — it links the existing lead into the new campaign and surfaces *"already exists in campaign X"* so the Admin decides. The unique indexes are the backstop that makes a concurrent double-import fail loudly rather than duplicate.

Note the consequence: two genuinely different people at the same company share a domain and will collide on `leads_domain_uk` if neither has an email. That is the accepted trade — at 50–100 leads per batch the Admin can adjudicate, and silent duplicates are worse. Rows with an email are unaffected, since the domain index only bites when it is the sole identifier. Revisit this if batches grow.

---

## 7. Row Level Security

RLS is enabled on **every** table. The application connects with the service role key, which bypasses RLS entirely — so the policies exist to guarantee that *nothing else* can read anything, including a leaked anon key or a misconfigured client.

```sql
ALTER TABLE campaigns       ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_batches  ENABLE ROW LEVEL SECURITY;
ALTER TABLE leads           ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_leads  ENABLE ROW LEVEL SECURITY;
ALTER TABLE recordings      ENABLE ROW LEVEL SECURITY;
ALTER TABLE intro_videos    ENABLE ROW LEVEL SECURITY;
ALTER TABLE videos          ENABLE ROW LEVEL SECURITY;
ALTER TABLE landing_pages   ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_runs        ENABLE ROW LEVEL SECURITY;
ALTER TABLE pipeline_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE logs            ENABLE ROW LEVEL SECURITY;
ALTER TABLE settings        ENABLE ROW LEVEL SECURITY;
ALTER TABLE heartbeat       ENABLE ROW LEVEL SECURITY;
```

### 7.1 Deny-all is the default

With RLS enabled and **no policy defined**, PostgreSQL denies every operation for non-superuser roles. Every table above except `heartbeat` therefore gets **no policies at all**. Writing an explicit `USING (false)` policy would be noise; the absence of a policy is the stronger and more obvious statement.

The Supabase linter reports this as twelve `rls_enabled_no_policy` **INFO** notices. They are the intended state, not a backlog.

#### 7.1.1 A second, independent layer: privileges

The migration also revokes table privileges:

```sql
REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;

GRANT INSERT ON public.heartbeat TO anon;   -- the single intentional grant
```

RLS alone satisfies §7. This exists because the two layers fail *differently*: RLS is per-table state that a stray `DISABLE ROW LEVEL SECURITY`, or one over-permissive policy added later, can undo — while a missing `GRANT` denies at the catalog level regardless of what any policy says.

It matters here specifically because Supabase's default privileges hand `anon` and `authenticated` full DML on anything created in `public`. Without the revoke, the heartbeat grant would be the only *deliberate* grant among thirteen inherited ones, and §7.3's careful argument about a bounded blast radius would rest entirely on RLS never regressing. `service_role` and `postgres` are untouched, so the application is unaffected.

`heartbeat.id` is `GENERATED ALWAYS AS IDENTITY`, whose sequence is owned by the column and needs no separate `USAGE` grant — which is why the sequence revoke does not break the keep-alive.

##### 7.1.2 Two gaps in that revoke, closed after review

Measuring the live project rather than re-reading the migration found that §7.1.1 was doing less than it claimed. Migration `20260722131125_default_privileges.sql` closes both:

1. **`REVOKE ... ON ALL TABLES` is point-in-time.** It says nothing about objects created later, and `pg_default_acl` still granted `anon`/`authenticated` `arwdDxtm` on tables, `rwU` on sequences and `X` on functions for anything `postgres` subsequently creates in `public`. Every phase from 4 onward adds objects.
2. **`ALL TABLES` never covered functions.** `seed_demo_data()` was revoked individually in §10.1 — which is exactly the remember-by-hand failure mode — and migration 03's four helpers were not remembered. `normalize_domain()`, `error_code_bucket()`, `next_lead_ref()` and `next_campaign_ref()` were all anon-`EXECUTE`-able over PostgREST RPC.

```sql
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES    FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM PUBLIC, anon, authenticated;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, anon, authenticated;
```

Neither gap was exploitable when found: the two ref functions run with invoker rights and `anon` has no `USAGE` on the sequences, so they error out; the other two are pure. The value is entirely forward-looking.

Two notes for anyone revisiting this. `ALTER DEFAULT PRIVILEGES` binds to the **current role** — `postgres` for migrations, which is the role carrying the grants; the parallel `supabase_admin` entries are platform-owned and left alone. And the live project ships a Supabase platform event trigger, `public.rls_auto_enable()`, that enables RLS on each new `public` table — so the residual risk here was never really about tables. It was about **views** (no RLS of their own, and the trigger fires only on `CREATE TABLE`) and **functions**, which is what the default privileges above actually close.

### 7.2 Realtime

Supabase Realtime respects RLS. Because the dashboard subscribes through the server, not the browser, no policy is needed to make live updates work — the server-side subscription uses the service role. Should a future change move subscriptions into the browser, that requires a real auth model, not a loosened policy.

**Two properties of the server-side subscription that are not obvious and have both already caused defects** (`lib/dashboard-stream.ts`, `lib/leads-stream.ts`; `PRD.md` Phase 13 findings 13/14):

- **Realtime is not a replay log.** A row that changes while the channel is still joining is never delivered — there is no catch-up on the wire. Both streams therefore do their own catch-up on `SUBSCRIBED` (the dashboard schedules a snapshot tick; the leads stream emits `resync`). Without it the only repair is the dashboard's `RESNAPSHOT_MS` safety net, and the leads stream has no such net at all.
- **`removeChannel()` dispatches `CLOSED` back into the `.subscribe()` callback.** If that handler tears down again without having cleared its own channel reference first, it recurses until the stack blows. The trigger is not a network fault but the **last subscriber leaving** — `realtime.disconnect()` never reaches the callback, because supabase-js reconnects the socket beneath it. Both streams clear the reference before calling, and `verify:dashboard` / `verify:leads` force the teardown in-process.

`campaign_leads` and `pipeline_events` carry `REPLICA IDENTITY FULL` (`20260720120500_ops_tables.sql:137-138`), which is what makes `DELETE` payloads include the old row — the leads stream reads `payload.old.id`. An unpaid WAL cost, recorded in `PRD.md` Phase 12's deferrals.

### 7.3 The one exception: `heartbeat`

```sql
CREATE POLICY heartbeat_insert_only ON heartbeat
  FOR INSERT TO anon
  WITH CHECK (source = 'github-action');
```

Insert only. No `SELECT`, `UPDATE` or `DELETE` policy exists, so the key cannot read back even what it wrote. The `WITH CHECK` pins the `source` value, so the key cannot be used to write arbitrary marker rows.

This is the whole reason the keep-alive uses a separate key: the GitHub Action runs in an environment whose secrets are outside our control surface, and the worst case for this key is an attacker adding rows to a table that exists solely to be written to.

---

## 8. Storage bucket

One bucket: **`lead-videos`**, public.

| Property | Value |
|---|---|
| Name | `lead-videos` |
| Public | Yes |
| Contents | **Only** the 720p web version of each final video |
| Path convention | `{uuid}/final.mp4` — a fresh UUID per video, unrelated to any other id |
| Content type | `video/mp4` |
| Cache-Control | `public, max-age=31536000, immutable` — paths are unique per encode, so a re-encode gets a new path rather than an invalidation |

```sql
INSERT INTO storage.buckets (id, name, public) VALUES ('lead-videos', 'lead-videos', true);

-- No policy on storage.objects. See §8.1 — this is the correction, not an omission.
```

The bucket is public because landing pages are static HTML on Netlify with no session — a signed URL would either expire or require a token in the page source, which is not meaningfully more private. Privacy comes from **unguessable paths** plus `noindex` on the landing pages, not from access control. The `{uuid}` segment is deliberately *not* the `videos.id` or `campaign_leads.id`: those appear in exports and the admin UI, and reusing them would let anyone holding one enumerate the other.

Masters, raw recordings and intro videos never leave local disk.

### 8.1 Why there is no `SELECT` policy — corrected during implementation

Draft 1 specified:

```sql
CREATE POLICY "lead videos public read" ON storage.objects
  FOR SELECT TO anon, authenticated USING (bucket_id = 'lead-videos');
```

That policy was applied, measured, and removed. It did not do what the surrounding paragraph claimed it did.

| Behaviour | With the policy | Without it |
|---|---|---|
| `GET /storage/v1/object/public/lead-videos/{path}`, no key — what a landing page does | `200` | `200` |
| `Range` request — what a `<video>` element does when seeking | `206` | `206` |
| Service-role upload — what the worker does | `200` | `200` |
| `POST /storage/v1/object/list/lead-videos` with the anon key | **returns every object** | `[]` |

A **public bucket serves its object route without consulting RLS at all**, so the policy bought nothing for playback. Its only real effect was to authorize the *list* endpoint — which turns "privacy comes from unguessable paths" into paths handed out on request. Every prospect's video, enumerable by anyone holding the anon key.

That key is not hypothetically exposed: §7.3 deliberately ships it to a GitHub Action, an environment whose secrets are outside our control surface. The whole argument for a separate insert-only key is that its worst case should be bounded; a bucket-listing grant unbounds it.

**Rule:** a public bucket needs no policy. If a future change makes the bucket private, the correct move is signed URLs at generation time, not a broad `SELECT` policy — the same trade §8 already rejected.

The Supabase database linter flags the original form as `public_bucket_allows_listing`. It is right.

---

## 9. Migrations

### 9.1 Layout

```
supabase/
  config.toml                            -- `supabase init`; db.major_version = 17,
                                         --   db.seed.sql_paths = ["./seed.sql"]
  migrations/
    20260720120000_extensions.sql        -- pgcrypto, citext
    20260720120100_enums.sql             -- §2
    20260720120200_functions.sql         -- §4 (functions + both ref sequences)
    20260720120300_core_tables.sql       -- campaigns, import_batches, leads, campaign_leads
    20260720120400_asset_tables.sql      -- intro_videos, recordings, videos, landing_pages
                                         --   + the four deferred FKs (see §9.3)
    20260720120500_ops_tables.sql        -- job_runs, pipeline_events, logs, settings, heartbeat
                                         --   + realtime publication (§5.10)
    20260720120600_indexes.sql           -- §6
    20260720120700_rls.sql               -- §7
    20260720120800_storage.sql           -- §8
    20260720120900_seed_function.sql     -- §10 — seed_demo_data()

    -- Added after the Phase 0–2 review (PRD.md §11):
    20260722131125_default_privileges.sql          -- §7.1.2
    20260722131136_normalize_domain_host_only.sql  -- §4.3

    -- Added in Phase 6 (PRD.md §11):
    20260723180000_import_commit_fn.sql            -- §5.2–5.3 — import_commit() + lead-slug helper

    -- Added after the Phase 6 review (PRD.md §11):
    20260723190000_import_batches_exists_list.sql  -- §5.2 exists_list + import_commit corrections

    -- Added in Phase 9 (PRD.md §11):
    20260725120000_encode_merge_timeout_setting.sql -- §5.12 — encode.merge_timeout_ms

    -- Added in Phase 10 (PRD.md §11):
    20260725180000_videos_poster_storage_key.sql   -- §5.7 — videos.poster_storage_key
    20260725180100_rename_campaign_slug_fn.sql       -- superseded by review migration below

    -- Added after the Phase 10 review (PRD.md §11):
    20260726120000_campaign_general_rpc.sql        -- update_campaign_general() RPC

    -- Added in Phase 11 (PRD.md §11):
    20260726130000_retained_pages.sql              -- §5.14 — retained_pages + delete RPCs
    20260726130100_campaign_leads_dry_run_deploy.sql -- §5.4 — deployed_dry_run + CHECK
    20260726130200_deploy_timeout_setting.sql    -- §5.12 — deploy.timeout_ms

    -- Added after the Phase 11 review (PRD.md §11):
    20260726140000_reconcile_manifest_deploy_rpc.sql -- one-statement post-deploy reconcile
    20260726140100_pending_site_sync.sql           -- §5.15 + widened snapshot + marker writes

    -- Added in Phase 12 (PRD.md §11):
    20260726150000_dashboard_counts_rpc.sql        -- dashboard_counts() — one read for the whole screen

    -- Added after the Phase 12 review (PRD.md §11):
    20260726160000_dashboard_counts_fixes.sql      -- scoped/recent ETA, processing order + SQL cap
    20260726170000_ref_padding_no_truncate.sql     -- §4.2 — lpad() truncation cliff
    20260726180000_dashboard_eta_samples_fn.sql    -- dashboard_eta_samples() — one copy of the rule
  seed.sql                               -- one line: SELECT public.seed_demo_data();
```

The two later migrations **amend** earlier ones rather than replacing them. §9.2 is forward-only: the ten original files are already applied and recorded, so editing one would be a no-op against any database that has it (`db push` compares recorded versions to filenames) while silently diverging from every database that does not. `20260720120700_rls.sql` and `20260720120200_functions.sql` therefore carry pointer comments marking them superseded — a reader who opens them first must not take them as current.

The `updated_at` triggers are **not** in the functions migration — a trigger needs its table, so each is attached beside its `CREATE TABLE`. The same applies to the indexes DB.md names inline in §5 (`recordings_lead_active_uk`, `job_runs_*`, `pipeline_events_lead_idx`, `logs_*`), which read as part of those tables' definitions; `20260720120600_indexes.sql` holds the §6 set only.

### 9.2 Rules

- **Forward-only.** No down migrations. Reverting means writing a new migration.
- Timestamped `YYYYMMDDHHMMSS_description.sql`, applied in filename order.
- Every migration is idempotent where PostgreSQL allows it (`IF NOT EXISTS`), so a partially applied migration can be re-run.
- Enum values are added, never removed or renamed. Note that `ALTER TYPE … ADD VALUE` **cannot run inside a transaction block** in older PostgreSQL and must be its own migration file, separate from any DDL that uses the new value.
- Applied via the Supabase CLI (`supabase db push`). Nothing in this phase touches a live project — the schema is specified here and applied in the implementation phase.

### 9.3 Splitting the tables across files

The three table migrations split on dependency order, not on theme: core tables have no FKs outside themselves, asset tables reference core, ops tables reference both. This keeps each file runnable in isolation against a database at the previous step, which is what makes debugging a failed push tractable.

**Four references run backwards** and had to be handled: `campaigns.intro_video_id` → `intro_videos`, and `campaign_leads.{recording_id, video_id, landing_page_id}` → the three asset tables. All four point from a core table into an asset table.

The resolution is to declare the **column** in `core_tables` and add the **`FOREIGN KEY` constraint** in `asset_tables`, once the target exists. Both properties survive: core still has no outward FK when it is applied, and the constraint is real by the end of the push. The alternative — moving `campaigns` after `intro_videos` — would have inverted the dependency for `import_batches`, which references `campaigns`, and produced a genuine cycle rather than a deferred edge.

`ALTER TABLE … ADD CONSTRAINT` has no `IF NOT EXISTS`, so each of the four is wrapped in a `DO` block that swallows `duplicate_object` — the same idempotency device §9.2 requires, applied where PostgreSQL gives no syntax for it. `CREATE TYPE` gets the same treatment in `20260720120100_enums.sql`; triggers use `CREATE OR REPLACE TRIGGER`, available since PostgreSQL 14.

---

## 10. Seed data

`seed.sql` provisions a demo campaign so a fresh clone has something to look at, and so the acceptance criteria in `PRD.md` §9 can be exercised without a real CSV.

```sql
-- Settings defaults (§5.12). Fourteen of the sixteen keys ship here;
-- encode.merge_timeout_ms (Phase 9) and deploy.timeout_ms (Phase 11) are inserted
-- by their own migrations instead (§5.12, §9.2).
INSERT INTO settings (key, value, description) VALUES
  ('recorder.viewport_width',   '1920',        'Browser width for website recording'),
  ('recorder.viewport_height',  '1080',        'Browser height for website recording'),
  ('recorder.nav_timeout_ms',   '120000',      'Give up loading a page after this long'),
  ('recorder.scroll_ease_ms',   '800',         'Ease-in/out ramp at each end of the scroll'),
  ('recorder.post_load_delay_ms','1500',       'Settle time after load before scrolling'),
  ('recorder.retention_days',   '30',          'Days to keep raw recordings before purging'),
  ('merge.pip_scale',           '0.20',        'Intro bubble width as a fraction of the frame'),
  ('merge.layout',              '"bubble_br"', 'Default picture-in-picture placement'),
  ('merge.max_stretch_factor',  '2.5',         'Above this, use the speed floor and hold instead'),
  ('encode.web_crf',            '28',          'x264 CRF for the 720p web version'),
  ('encode.web_audio_kbps',     '96',          'AAC bitrate for the 720p web version'),
  ('queue.concurrency',         '1',           'Simultaneous pipeline jobs (tested to 3)'),
  ('queue.auto_retry_limit',    '2',           'Automatic retries before a step is marked failed'),
  ('deploy.dry_run',            'false',       'Run the full pipeline but skip Netlify')
ON CONFLICT (key) DO NOTHING;

-- Demo campaign. No intro video: this is the state that demonstrates the
-- "Paused – Needs Intro" path, which is the single most common first-run
-- surprise and therefore worth seeding deliberately rather than avoiding.
INSERT INTO campaigns (name, slug, description, landing_template, cta_type, cta_label, cta_url)
VALUES (
  'Demo Campaign',
  'demo',
  'Seeded example. Assign an intro video to unpause its jobs.',
  '<!doctype html>…{{video_url}}…{{cta_url}}…',  -- full template in the migration file
  'calendar',
  'Book a 15-minute call',
  'https://example.com/book'
) ON CONFLICT (slug) DO NOTHING;
```

Three demo leads are seeded against stable, recordable public sites, linked into the demo campaign at `status='paused'`, `current_step='merge'`, `error_code='intro_missing'` — the exact state a real import reaches when no intro is assigned. Assigning any intro video and hitting Resume completes the pipeline, which makes the seed a working end-to-end smoke test rather than decoration.

`seed.sql` is idempotent and safe to re-run.

### 10.1 How the seed is actually shipped

`seed.sql` is one line:

```sql
SELECT public.seed_demo_data();
```

Everything above lives in that function, created by `20260720120900_seed_function.sql`.

**Why.** Phase 1 requires `npm run seed` to run the seed, and `scripts/seed.ts` reaches the database over PostgREST with `supabase-js` — which cannot execute raw SQL, and has no connection string available among the eight environment variables (`Tech.md` §14.1). The choice was to maintain the seed twice, once as SQL for `supabase db reset` and once as JavaScript upserts for `npm run seed`, or to write it once and give it two thin callers. Two copies of a seed drift; the drift is silent, and it surfaces as a demo that works on a fresh clone but not on a `db reset`.

```
supabase/seed.sql   ──┐
                      ├──▶  public.seed_demo_data()  ──▶ jsonb report
scripts/seed.ts   ────┘      (idempotent, guarded inserts)
```

The function returns a report — `{settings_inserted, campaign_created, leads_inserted, campaign_leads_inserted, events_inserted}` — so `npm run seed` prints what it actually did rather than announcing success unconditionally. A second run prints zeroes.

**Security.** The function writes every table in the schema, and PostgreSQL grants `EXECUTE` to `PUBLIC` by default — which would have handed the anon key a way to write rows RLS otherwise forbids. It is therefore `REVOKE`d from `PUBLIC`, `anon` and `authenticated`, and granted to `service_role` alone. Verified: an anon RPC call returns `42501 permission denied for function seed_demo_data`.

**Idempotency device.** Guarded `WHERE NOT EXISTS` inserts rather than `ON CONFLICT DO NOTHING` for the campaign and the leads. Both are idempotent for *rows*, but `ON CONFLICT` still evaluates the column defaults first, which consumes a value from `lead_ref_seq` / `campaign_ref_seq`. Sequences do not roll back, so the fourth re-run of the seed would leave the operator's first real campaign at `CMP-05`. `settings` keeps `ON CONFLICT (key) DO NOTHING`, which has no such default and — importantly — must **not** be `DO UPDATE`, or re-seeding would silently revert whatever the operator changed on the Settings screen.

**What gets seeded.** `LD-0001` Mozilla Foundation, `LD-0002` Wikimedia Foundation, `LD-0003` Free Software Foundation, all into `CMP-01 Demo Campaign`, each with two `pipeline_events` so the detail drawer has a timeline to render.

The three carry **no email addresses**. They are real organizations, and inventing a contact at one would put a fabricated person into a table that feeds outreach exports. Domain-only is also the more honest demo: it exercises the domain-only dedupe path of §6.1, and it leaves `{{email}}` rendering empty, which demonstrates §5.1.1's rule that a missing value never blocks a deploy.

> **Known gap, carried to Phase 7.** The seeded rows sit at `current_step='merge'` with `recording_id` null — no `recordings` row exists, because seeding one would mean seeding a video file. §10's specified state is transcribed faithfully, but it means the worker's merge step must treat "no recording at all" as *record first*, not as `missing_asset` (`Tech.md` §11, which currently only distinguishes purged from missing). AC-4 depends on that resolution.

---

## 11. Open items

Carried into `Tech.md` review rather than resolved here:

1. **Domain-only collisions** (§6.1) — accepted at current volume; revisit if batches exceed a few hundred.
2. **`landing_pages.html` storage cost** — full HTML per lead. At 100 leads × ~20KB this is trivial; at 100k it would want a content-addressed table keyed by `content_sha1`. Not worth building now.
3. **`pipeline_events` growth** — unbounded and never pruned. Fine at this scale; note it before any bulk-import feature lands.
4. **Queue backend** — the schema assumes BullMQ owns queue state and the database only mirrors it via `job_runs`. If the Supabase-job-table alternative in `Tech.md` §7 is chosen instead, `job_runs` gains claim columns (`claimed_by`, `claimed_at`, `visible_after`) and a `FOR UPDATE SKIP LOCKED` claim query. The rest of this schema is unaffected — which is why the decision can be deferred.

Raised by the Phase 1 implementation, and **not** resolvable in the schema:

5. ~~**No public poster frame.**~~ **Resolved in Phase 10.** The merge step uploads `poster.jpg` beside the video (`videos.poster_storage_key`, key `{video prefix}/poster.jpg`); the page step derives `{{poster_url}}` from it. Posters encoded at 720px wide (`-q:v 4`); upload failure is non-fatal (page renders posterless with the `preload="metadata"` fallback). No backfill for leads merged before this change — they stay posterless until a `step:merge` re-uploads. Local `poster_path` is kept indefinitely as the admin thumbnail.
6. ~~**Merge with no recording at all.**~~ **Resolved in Phase 7.** Record-first-and-continue at most once per job; see `Tech.md` §11 item 5.
7. **`seed_demo_data()` ships in the schema.** A seed function living in a migration is unusual; it is the price of a single source of truth for the seed (§10.1). If migrations ever need to be replayed against a production-like database, this function will be created there too. It is `REVOKE`d from every non-service role, so the exposure is nil, but it is worth remembering that it exists.
8. **`deploy_status='removed'`** — enum value reserved for Phase 13 per-page unpublish UI. Phase 11 unpublishes via manifest omission only; the value is documented in §2.5, and the deploy step now handles it as a stale page so the Phase 13 button cannot strand a lead.
9. **`pending_site_sync` is never pruned on abandonment.** A marker whose sync keeps failing stays forever and keeps re-enqueueing — deliberate (a stranded published page is worse than a noisy queue), but there is no age-out and no UI showing the backlog. Phase 14's Logs/Queue screens should surface a marker older than, say, an hour.
10. **`reconcile_manifest_deploy` status guard is duplicated four times** in the RPC — one `CASE` per column, all with the same predicate. Postgres has no multi-column conditional assignment; a `FROM ... WHERE` split into two statements would read better but would touch `netlify_url` and `status` in separate passes. Revisit if the guard grows.
