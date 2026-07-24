# Personalizer — Product Requirements

**Status:** Draft 1 — authoritative for product scope and build sequencing.
**Companions:** `docs/Tech.md` (architecture, pipeline, framework constraints), `docs/DB.md` (schema).

---

> ## ⚠️ UI stack is decided — do not choose another
>
> This project uses **shadcn/ui**, initialized from a specific preset. The exact command is:
>
> ```bash
> npx shadcn@latest init --preset bKsEuMcK --template next --pointer
> ```
>
> **This is not a suggestion or a default to be reconsidered.** Any agent building UI here must use the components, tokens, and theme this preset installs. Do not hand-roll components the preset provides, do not introduce a second component library (MUI, Chakra, Mantine, Ant, Headless UI, DaisyUI), and do not override the preset's theme tokens with ad-hoc Tailwind colors.
>
> **The preset has been run.** It resolved to style `base-luma`, base color `stone`, icons `lucide-react`, and primitives from **`@base-ui/react` — Base UI, not Radix UI.**
>
> ⚠️ **Most shadcn/ui knowledge assumes Radix (`@radix-ui/react-*`). This project does not use it.** Do not install it, import from it, or copy Radix-based component source from memory — import paths and several component APIs differ. Read `components/ui/` or the installed `@base-ui/react` package for the real API.
>
> Adding a component is always `npx shadcn@latest add <component>` — never a manual copy-paste into `components/ui/`. This applies to **all** UI primitives, not only the ones the preset ships.
>
> The same rule is recorded in `AGENTS.md`, which loads into every agent session. If the two ever disagree, `AGENTS.md` wins and this block should be corrected to match.

---

## 1. Context

Personalizer is the middle stage of a three-application system:

```
┌──────────────┐     CSV      ┌──────────────┐   landing URLs   ┌──────────────┐
│ Lead Finder  │─────────────▶│ Personalizer │─────────────────▶│ Outreach/CRM │
│  (exists)    │   of leads   │  (this app)  │   + video URLs   │   (future)   │
└──────────────┘              └──────────────┘                  └──────────────┘
   finds and                   turns each lead into              sends the emails
   exports leads               a personalized video +            and tracks replies
                               a public landing page
```

**Lead Finder** already exists and produces CSV exports. **Outreach/CRM** does not exist yet and is explicitly out of scope. Personalizer's job is the middle: take a CSV of leads, and for each one produce a video that shows *that lead's own website* being scrolled while the operator's pre-recorded pitch plays in a corner bubble, published to a public landing page whose URL can be pasted into an outreach email.

The value is that the recipient sees their own site in the first two seconds. Nothing about the pitch changes per lead — the *context* does.

**Deployment reality:** this runs locally on one Windows workstation, operated by one person, at 50–100 leads per import batch. It is not a SaaS, not multi-tenant, and not internet-facing. Every design decision in the companion documents follows from that.

---

## 2. Goals and non-goals

### 2.1 Goals

1. Import a Lead Finder CSV and process every row without further input.
2. Record each lead's website automatically and reliably enough that failures are the exception and are always explained.
3. Produce a video whose length is governed by the operator's intro, so the pitch never gets cut off or padded.
4. Publish a mobile-first landing page per lead at a human-readable URL.
5. Give the operator one screen that answers "what is happening, what broke, and what do I do about it."
6. Export reviewed leads with working URLs, ready to hand to outreach.
7. Make every failure recoverable without touching a database or a terminal.

### 2.2 Non-goals — stated as prohibitions, not omissions

These are not "later." They are things this product deliberately does not do, and an agent proposing them is proposing scope creep:

- **No AI. Anywhere.** No copy generation, no summarization, no subject lines, no LLM calls of any kind. The pitch is a video the operator recorded once, by hand.
- **No website analysis.** The recorder scrolls the page and films it. It does not read, score, classify, or extract anything from the lead's site.
- **No content generation.** Landing page text comes from a template the operator wrote, with field substitution. Nothing is invented.
- **No sending.** Personalizer never sends an email, DM, or message. It produces URLs; outreach is a different application.
- **No tracking.** Landing pages carry no analytics, no pixels, no third-party requests. There is no open-rate, no click count, no visitor log.

The absence of tracking is a product position, not an oversight: these pages name individual businesses and are `noindex`-ed for the same reason.

---

## 3. Roles and access

**One role: Admin.** One shared password (`APP_PASSWORD`), one session cookie. No user accounts, no registration, no roles, no permissions matrix, no audit-by-user.

There is exactly one privilege boundary in the product — logged in, or not — and it is enforced server-side inside every route handler and server action, not by the page shell (`Tech.md` §4.2).

Landing pages are the one public surface. They are unauthenticated by necessity — a recipient clicks a link from an email — and are protected by unguessable video paths plus `noindex`, not by access control.

---

## 4. Core concepts

Four nouns. Getting the relationship right is the single most load-bearing thing in this product.

| Concept | What it is | What it is not |
|---|---|---|
| **Campaign** | A named container: one intro video, one merge style, one landing template, one CTA. | Not a folder of leads. Leads are *assigned* to it, not owned by it. |
| **Import Batch** | One CSV file, imported once, into one campaign. An audit record. | Not a work queue and not a grouping the operator manages afterward. |
| **Lead** | A business/person: name, company, email, website, city. Pure identity. | **Has no status.** Carries no assets, no URL, no pipeline state. |
| **Campaign Lead** | One lead's participation in one campaign. | — |

### 4.1 `campaign_leads` is the unit of work

```
   Lead "Acme Plumbing"                  Campaign "Q3 Roofers"
   LD-0042                               CMP-01
   ├─ email, domain, city                ├─ intro video A
   └─ ONE recording (reused) ────┐       └─ template A
                                 │
                                 ├──▶ campaign_leads #1
                                 │    status: ready
                                 │    /q3-roofers/acme-plumbing-portland
                                 │    video A + recording
                                 │
                                 └──▶ campaign_leads #2      Campaign "Q4 Retarget"
                                      status: processing     CMP-02
                                      /q4-retarget/acme-...  ├─ intro video B
                                      video B + same rec.    └─ template B
```

**A lead may be processed once per campaign.** The same business can appear in three campaigns and get three different videos, three different landing pages, and three independent statuses — built from **one** website recording, captured once and reused.

Everything the pipeline touches — status, current step, slug, published URL, error, assets — lives on `campaign_leads`. When this document says "a lead is `Failed`," it always means a lead *in a campaign*.

> **This supersedes the original brief**, which treated a lead as globally single-use. That model could not express "same business, second campaign, new pitch," which is the actual repeat-outreach workflow.

### 4.2 Why recording is campaign-agnostic

A website recording depends only on the website. It does not depend on which pitch is playing over it. Capturing it once per *lead* rather than once per *campaign lead* is why a second campaign against the same list costs merge-and-deploy instead of a full re-crawl — and it is why a campaign with no intro video still does useful work before it pauses (§7.3).

---

## 5. Workflows

### 5.1 First run, end to end

1. **Create a campaign.** Name it; a slug is derived. It has no intro yet.
2. **Upload an intro video.** Record the pitch once, upload it. It is normalized and its duration cached — that duration becomes the master clock for every video in campaigns using it.
3. **Assign the intro** to the campaign.
4. **Import a CSV.** Pick the file and the target campaign. The importer reports: *N imported, N linked from other campaigns, N duplicates skipped, N not-a-website, N rejected rows (with line numbers)*.
5. **Processing starts automatically.** No "start" button. Every imported lead is `Queued` and the worker begins.
6. **Watch, or walk away.** The dashboard updates live. A 100-lead batch runs unattended.
7. **Review.** Failures are grouped by cause. Successes sit at `Deployed` with a clickable landing URL.
8. **Promote to `Ready`.** Spot-check videos, then bulk-approve. This is the only manual gate.
9. **Export.** CSV of `Ready` leads with landing and video URLs, for outreach.

Steps 1–3 are once-per-campaign. Steps 4–9 repeat per batch.

### 5.2 Import before an intro exists

Permitted and unremarkable. Every lead records its website, then parks at `Paused – Needs Intro`. Assigning an intro resumes them all from the merge step. Nothing is wasted and nothing is lost.

This is the seeded demo campaign's state on a fresh clone (`DB.md` §10) — deliberately, because it is the most common first-run surprise and is better demonstrated than avoided.

### 5.3 Re-running a lead in a second campaign

Import the same CSV into a different campaign. The importer recognizes every lead by domain or email, reports *"already exists in campaign X"*, and links them in rather than duplicating. The existing recordings are reused; only merge, page, and deploy run.

The importer never merges or overwrites lead records on its own. The operator decides.

### 5.4 Recovering a failure

From the leads table, filter by error bucket. For each lead the drawer shows what broke, at which step, with the before/after debug screenshots. Options: **retry from the failed step**, **force a full restart**, or **re-run one step in isolation**. Non-recoverable cases (dead domain) are for fixing the data or dropping the lead.

### 5.5 Deleting

Deleting a lead or a campaign prompts: **"Also remove the published landing page(s)?"** Answering yes issues an unpublish deploy before the records are removed. Answering no leaves the pages live and orphaned — a legitimate choice when links are already out in emails.

---

## 6. Screens

Eight. Live regions update via Supabase Realtime with a 5-second polling fallback (`Tech.md` §13).

### 6.1 Dashboard

The default screen and the "what is happening" answer.

- **Campaign selector** with an **"All campaigns"** option. Every count below respects it.
- Status tiles: `Queued` / `Processing` / `Paused` / `Deployed` / `Ready` / `Failed` / `Skipped`. Clicking one opens Leads filtered to it.
- Active batch progress: *"Batch 3: 47 of 100 complete, ~22 min remaining"* — estimate from a rolling mean of recent per-lead durations.
- Currently processing: lead name, current step, elapsed.
- Failures grouped by bucket: **Bad Website** / **Blocked** / **System**, each a link to the filtered list.
- **`Paused – Needs Intro` is a banner, not a tile** — it is an instruction, and it names the campaign and links straight to intro assignment.

States: empty (no campaigns → "Create your first campaign"), idle, running, all-done.

### 6.2 Campaigns

**List:** name, `CMP-01` ref, intro assigned (yes/no — visually loud when no), lead count by status, created date, archived state.

**Detail / settings:** name, slug (immutable after first deploy — it is in published URLs), description, intro assignment, merge layout + PiP scale with a preview, landing template editor with a placeholder reference (`DB.md` §5.1.1) and a live preview against a sample lead, CTA (type, label, URL), recorder overrides (viewport, timeout), archive, delete.

Changing the intro on a campaign with existing videos does **not** retroactively re-merge. Already-built videos are finished files; the change applies to leads not yet merged. The UI must say this where the intro is changed — silently diverging output is the worst outcome here.

### 6.3 Leads

TanStack table, the main working surface.

- Columns: `LD-` ref, name/company, website, city, campaign, status badge, current step, error bucket, landing URL, updated.
- Filters: campaign, status, error bucket, batch, free-text.
- Sort on any column; pagination or virtualization at 100+ rows.
- Bulk selection → **promote to Ready**, **retry**, **delete**.
- Row click → **detail drawer**:
  - Lead fields (editable — fixing a typo'd URL is a real recovery path)
  - Recording thumbnail + inline player
  - Final video player
  - Landing URL: clickable, copyable
  - **Status timeline** from `pipeline_events`, newest first
  - Per-step retry buttons
  - Error code, human message, and debug screenshots when failed
  - Stretch factor and speed-floor indicator when the video's pacing looks off (`DB.md` §5.7)

### 6.4 Queue / Jobs

Live worker view: active jobs with step and elapsed; queued depth; recently completed with durations; recently failed with error and attempt count. Controls: pause/resume the queue, adjust concurrency, clear the queue. Worker connection status — **prominent when the worker is not running**, because "nothing is happening" and "the worker is down" look identical from the dashboard otherwise.

### 6.5 Intro Videos

Grid of uploaded intros: poster thumbnail, name, **duration (shown large — it is the master clock)**, resolution, size, which campaigns use it. Upload with progress (large files, Route Handler — `Tech.md` §4.3), normalization progress, inline preview, rename, delete (blocked with an explanation if in use, since deleting re-pauses that campaign).

### 6.6 Import

Campaign picker → file picker → **preview before commit**: detected delimiter, header→field mapping (correctable), first 5 rows as they will be stored, and counts of what will happen (new / linked / duplicate / skipped / rejected). Then commit.

**Post-import report**, persisted and re-viewable: the five counts, the "already exists in campaign X" list, and rejected rows with 1-based line numbers matching a text editor (`Tech.md` §5.1).

### 6.7 Logs

System log viewer over the `logs` table: filter by level, scope, campaign lead, time range; expandable rows for stack traces and FFmpeg stderr. This is the "why," not the "what" — the timeline in the lead drawer is the "what" (`Tech.md` §13).

### 6.8 Settings

Global defaults from the `settings` table (`DB.md` §5.12), grouped: Recorder, Merge, Encode, Queue, Deploy. Each with its description as help text and its default shown. Plus environment health — the eight variables, present/missing, **values never displayed** — and a Redis connection indicator.

Every setting must state where it can be overridden. Resolution is always **lead → campaign → global** (`Tech.md` §14.2).

---

## 7. Status model, from the operator's chair

Two fields (`DB.md` §2.1–2.2): `status` answers "can I do something about this?", `current_step` answers "where is it?".

| Status | Means | Operator sees | Action available |
|---|---|---|---|
| `Queued` | Waiting for a worker | Grey badge, position | Cancel, delete |
| `Processing` | A worker holds it | Blue badge + step name | Watch |
| `Paused` | **Blocked on you** | Amber badge + reason | Assign intro, resume |
| `Deployed` | Live, unreviewed | Green badge, URL | Review → promote |
| `Ready` | Reviewed, exportable | Solid green | Export |
| `Failed` | Retries exhausted | Red badge + reason | Retry, restart, edit, delete |
| `Skipped` | Excluded at import | Grey, struck through | Fix URL and requeue |

Step order is fixed: **recording → merge → page → deploy**.

### 7.1 `Deployed` vs `Ready` — why both

Deploy is a machine outcome. `Ready` is a human assertion that someone looked at the video and it is not embarrassing. Automating the promotion would remove the only quality gate in a system that publishes pages naming real businesses. Export defaults to `Ready` for exactly this reason.

Promotion is bulk-approvable — the gate is meant to be cheap, not tedious.

### 7.2 The retry contract

Automatic: **2 retries per step**, 30s/60s backoff, then `Failed`. `attempt_count` resets when the step advances — failing once at recording and once at deploy exhausts nothing.

`Bad Website` errors **skip retries entirely** and fail immediately. A domain that does not resolve will not resolve in 30 seconds, and 100 dead leads × 2 pointless attempts is minutes of nothing (`Tech.md` §7.3).

Manual: **retry** resumes from the failed step; **force full restart** discards assets and re-records; **per-step rerun** re-runs one step alone. Retry never re-runs a step that already succeeded unless the operator explicitly asks — re-recording is the most expensive thing the system does.

### 7.3 `Paused – Needs Intro`

The one status that is an instruction. Recording has already finished; the job stopped at merge because the campaign has no intro. Assigning one resumes everything. The dashboard states this as a sentence with the campaign name and a direct link, not as a count.

### 7.4 Interruptions

If the worker dies mid-run, jobs resume from their last completed step on the next boot, automatically, and the timeline records an `Interrupted` event so the gap is explained. No operator action, ever.

---

## 8. Errors, from the operator's chair

Granular codes, three buckets (`DB.md` §2.3–2.4). The bucket answers *whose problem is this*:

| Bucket | Meaning | Typical response | Auto-retry |
|---|---|---|---|
| **Bad Website** | The lead's site is the problem | Fix the URL, or drop the lead | No |
| **Blocked** | The site refused us | Retry; may need dropping | Yes |
| **System** | We broke | Retry; check logs if it repeats | Yes |

Every failure must present, without opening Logs: a plain-sentence description, which step, how many attempts, before/after screenshots where relevant, and the available actions. If an operator has to read a stack trace to know what to do, the error message has failed.

**Actionable:** `nav_timeout`, `bot_detected`, `login_required` (retry or drop) · `missing_asset` (re-record) · `intro_missing` (assign an intro) · `disk_full`, `netlify_failure`, `storage_upload_failed` (fix and retry) · `not_a_website` (correct the URL).

**Terminal without a data fix:** `dns_failure`, `connection_refused`, `parked_domain`, `http_4xx`, `empty_page`. The site is gone or is not a site. Retrying is theater.

**Every code in `DB.md` §2.4 must map to a documented recovery path.** That is an acceptance criterion (§9), not a nice-to-have.

---

## 9. Acceptance criteria

The definition of done. All seven must hold.

**AC-1 — Unattended 100-lead run.** Import a 100-lead CSV into a campaign with an intro assigned. Without further input, every lead reaches a terminal state (`Deployed`, `Failed`, or `Skipped`). No hang, no silent stall, no state requiring a restart to progress.

**AC-2 — Promote and export.** Bulk-promote `Deployed` → `Ready`, export CSV. Every `landing_url` loads a working page; every page's video plays on desktop and mobile; every `video_url` resolves.

**AC-3 — Every failure has a documented recovery.** Each `error_code` in `DB.md` §2.4 has: a plain-language message, a bucket, an operator action (or an explicit "terminal, fix the data"), and a place in the UI where that action can be taken.

**AC-4 — Seeded demo campaign.** A fresh clone, after migrations and seed, has a working demo campaign with leads in `Paused – Needs Intro`. Assigning any intro and resuming carries them through to a deployed page — a real end-to-end smoke test, not decoration.

**AC-5 — Fresh-Windows README.** A person with a clean Windows machine and the repo can reach a running app by following the README alone: prerequisites, Redis, env, migrations, seed, `npm run dev` + `npm run worker`. No undocumented steps, no tribal knowledge.

**AC-6 — `--dry-run`.** With `settings.deploy.dry_run` on, the full pipeline runs — record, merge, generate, store — and skips every Netlify call. Used to exercise AC-1 without publishing.

**AC-7 — Interruption safety.** Kill the worker mid-batch. On restart, in-flight leads resume from their last completed step, with an `Interrupted` event on each timeline. No duplicates, no corrupt outputs, no manual repair.

---

## 10. Out of scope

**Deferred (plausible later):** outreach sending and CRM integration · open/click tracking · custom domains for landing pages · multi-user accounts and roles · A/B testing intros · scheduled or drip campaigns · webhooks · lead scoring · a hosted/multi-tenant deployment.

**Rejected (not "later"):** AI features of any kind · website content analysis · generated copy · autoplay landing pages · third-party tracking on landing pages · public search indexing of landing pages.

---

## 11. Build phases

Sequenced so each phase is independently verifiable and leaves the app in a working state. **Do not start a phase whose prerequisites are unmet** — the ordering exists because later phases assume earlier invariants.

Each phase lists its exit criteria. Exit criteria are binary: an agent should be able to say *done* or *not done* without judgment.

### Stage A — Foundation

---

#### Phase 0 — Project setup and UI stack ✅ **DONE** (2026-07-22)

**Goal:** dependencies installed, shadcn preset applied, project structure in place.

1. ~~Run **`npx shadcn@latest init --preset bKsEuMcK --template next --pointer`**~~ — ✅ **DONE.** Produced `components.json` (style `base-luma`, `@base-ui/react`, stone, lucide), `components/ui/button.tsx`, `lib/utils.ts`, and an updated `app/globals.css` + `app/layout.tsx`. `npm run build` verified passing.
2. Install runtime deps: `@supabase/supabase-js`, `bullmq`, `ioredis`, `playwright`, `ffmpeg-static`, `ffprobe-static`, `jose`, `server-only`, `@tanstack/react-table`, `csv-parse`, `zod`.
3. Dev deps: `tsx`, `supabase` CLI.
4. `npx playwright install chromium`.
5. Create the directory skeleton from `Tech.md` §3.
6. Scripts per `Tech.md` §16.1 — **`dev` must carry `-H 127.0.0.1`**.
7. `.env.example` with all eight variables (`Tech.md` §14.1).
8. `lib/env.ts`: validate all eight at startup in both processes; refuse to boot naming *every* missing variable at once.

**Exit:** `npm run dev` serves on 127.0.0.1:3000 with a shadcn-styled page; `npm run build` succeeds; booting with a missing env var fails with a message naming it. `next.config.ts` contains no `webpack` key (`Tech.md` §14.3).

**Exit — all five met:**

| Criterion | Result |
|---|---|
| `npm run build` succeeds | ✅ Clean production build with shadcn preset, env validation, and directory skeleton in place. |
| Missing-env boot refuses and names every missing variable | ✅ `npx tsx -e "import('./lib/env-node.js').then(m => m.assertEnvOrExit({}))"` exits non-zero listing all eight required variables. |
| `next.config.ts` contains no `webpack` key | ✅ Empty config object only — no custom webpack hook. |
| `dev` script binds to loopback | ✅ `"dev": "next dev -H 127.0.0.1"` in `package.json`. |
| `npm run verify:imports` passes | ✅ All runtime imports resolve; ffmpeg and ffprobe binaries present on disk. |

---

#### Phase 1 — Database ✅ **DONE** (2026-07-21)

**Goal:** the full schema, applied and seeded.

~~Implement `DB.md` end to end: extensions, enums (§2), functions and triggers (§4), tables (§5), indexes (§6), RLS (§7), storage bucket (§8), migrations in the order of §9, seed of §10.~~

Applied to the Supabase project *Personalizer* as ten migrations (`DB.md` §9.1). Live inventory: **13 tables · 9 enum types · 40 indexes · 17 foreign keys · 13 check constraints · 8 `updated_at` triggers · 2 generated columns · RLS on 13/13 · 1 public bucket.**

> **Two further migrations were added and applied on 2026-07-22** after the Phase 0–2 review (`20260722131125_default_privileges.sql`, `20260722131136_normalize_domain_host_only.sql`) — see the corrections block below. The inventory above is unchanged: neither adds or alters a table. Both filenames match their recorded `schema_migrations` versions, so `db push` stays a no-op.

**Exit — all four met:**

| Criterion | Result |
|---|---|
| Migrations apply cleanly against an empty project | ✅ Ten migrations, in filename order, against a project with zero user tables. `supabase/config.toml` written by `supabase init`; recorded versions match the filenames exactly, so a subsequent `db push` is a no-op rather than a replay. |
| `npm run seed` is idempotent | ✅ First run: 14 settings, 1 campaign, 3 leads, 3 campaign leads, 6 events. Second run: all zeroes, *"nothing changed — the database was already seeded."* |
| RLS: anon reads *nothing*; `heartbeat` insert only with `source='github-action'` | ✅ Anon `SELECT` denied on **13/13** tables (`42501`). Insert with `source='github-action'` → `201`; with any other source → `42501` *"new row violates row-level security policy"*. Insert into `leads` → denied. `seed_demo_data()` via RPC → denied. |
| Generated columns compute correctly | ✅ `error_bucket`: all 21 `error_code` values bucket 8/5/8 as specified, recompute on `UPDATE`, and return to `NULL` when the code is cleared. `duration_ms`: 8412 for an 8.412 s run, `NULL` while a run is open. |

Also verified by a 16-case suite run inside a self-aborting transaction: both `UNIQUE` rules on `campaign_leads`, the `ready`/`deployed`/`failed` status guards, the partial `recordings_lead_active_uk` (second active recording rejected; re-record allowed after `purged_at` is set), `leads_identifiable_ck`, case-insensitive `citext` email dedupe, campaign slug format, `content_sha1` format, `normalize_domain()`, and both ref sequences.

**Two corrections landed during implementation** — see `DB.md` §8.1 and §10.1:

1. The drafted `SELECT` policy on `storage.objects` was **removed**. It did not enable public playback (a public bucket serves its object route without consulting RLS); its only effect was to authorize bucket *listing*, making every prospect's video URL enumerable by the anon key — which is the key §7.3 deliberately ships to GitHub. Measured both ways before removing.
2. The seed ships as one idempotent SQL function with two thin callers, so `supabase db reset` and `npm run seed` cannot drift.

**Three open items were raised and deferred to the phases that can actually decide them** (`DB.md` §11 items 5–7): no public poster frame (Phase 10), merge-with-no-recording (Phase 7), and the seed function living in the schema.

---

#### Phase 2 — Authentication ✅ **DONE** (2026-07-22)

**Goal:** the app is locked, and the lock actually holds.

~~1. `lib/session.ts` — jose HS256 sign/verify, httpOnly cookie, 7-day expiry.~~
~~2. `lib/dal.ts` — `verifySession()`, wrapped in `react.cache`, importing `server-only`.~~
~~3. `proxy.ts` at the project root — **not `middleware.ts`** (`Tech.md` §4.1), optimistic cookie-presence check only.~~
~~4. `POST /api/login` (timing-safe compare against `APP_PASSWORD`, 5/min/IP rate limit), `POST /api/logout`.~~
~~5. Login page.~~

**Exit — all three met:**

| Criterion | Result |
|---|---|
| Unauthenticated app routes redirect to `/login` | ✅ `proxy.ts` redirects browsers without `pz_session`; `/login?next=…` preserves the intended destination. |
| `verifySession()` in every protected handler; direct curl POST without cookie returns 401 | ✅ `GET /api/session` returns `401 {"error":"unauthorized"}` with no redirect; proven by `npm run verify:auth`. |
| All `cookies()` calls awaited | ✅ `lib/dal.ts`, login/logout handlers, and auth pages use `await cookies()` throughout. |

Proxy matcher corrected: `api/login` and `api/logout` excluded from the negative lookahead so login POST is not redirected (`Tech.md` §4.1).

---

#### Corrections landed after review of Phases 0–2 (2026-07-22)

A review of the three completed phases found no blockers — `npm run build`, `tsc --noEmit` and `eslint .` were clean, the Next 16 `proxy.ts` convention was correctly applied, and the live database matched `DB.md` exactly. Six substantive items and six nits were fixed before Phase 3 opened. The four that changed behaviour:

1. **The login limiter was bypassable.** `clientKey()` keyed on `x-forwarded-for`, which nothing sets in this deployment and any caller can forge — a fresh header value bought a fresh bucket, so the tiers never fired. Since this is the only brute-force control over `APP_PASSWORD`, a bypassable limiter reads as protection that is not there. It is now **one global bucket**, which is also the honest model for a single-operator tool. Reverses D13.

2. **`/api/login` read `process.env.APP_PASSWORD ?? ''`.** `passwordMatches('', '')` returns `true`, so the fallback encoded "an empty expected password is acceptable". Not reachable — `instrumentation.ts` refuses the boot first — but it is now `assertEnv().APP_PASSWORD`, making a misconfiguration a 500 rather than an open door.

3. **Privilege gaps, found by measuring the live project rather than re-reading migration 07** (`DB.md` §7.1.2). Its `REVOKE` was point-in-time and never covered `FUNCTIONS` at all, so migration 03's four helpers were anon-`EXECUTE`-able and every object added in Phases 4–16 would have arrived with `anon` grants. Neither was exploitable when found. Closed by `20260722131125_default_privileges.sql`.

4. **`normalize_domain()` had two contradicting contracts** (`DB.md` §4.3, `Tech.md` §5.2). Following `Tech.md` literally would have keyed `https://acme.com/about-us` as `acme.com/about-us` and silently failed to dedupe it — a Phase 6 landmine that only stayed hidden because the seed passes bare hosts. Both layers corrected: the importer passes the host, and the function now reduces a full URL to one itself (`20260722131136_normalize_domain_host_only.sql`).

Also: the login form's lockout countdown was deleted. It was driven by a client-local counter that reset on reload and never decayed, so it both hid real lockouts behind a bare "Incorrect password" and invented lockouts that had already expired; the server returns an identical 401 at every tier by design (D14), so the client cannot honestly render a timer. `proxy.ts` now forwards `x-pathname` so the expired-cookie path preserves `?next=` the way the no-cookie path already did (D46). `safeNext()` moved to `lib/next-path.ts` as the single sanitizer for both.

**A test suite was added** — `npm test`, `node --test` via the existing `tsx` dev dependency, no new packages. 34 cases over the limiter tiers, `validateEnv`'s absent-vs-invalid relabelling, `safeNext`'s open-redirect guard, and session sign/verify. This makes the previously dead `resetRateLimiter()` and `resetEnvCache()` exports live.

---

#### Phase 3 — App shell ✅ **DONE** (2026-07-23)

**Goal:** navigable skeleton with all eight screens present.

~~Authenticated layout, sidebar navigation, shadcn theme wired, empty-state placeholders for all eight screens, `lib/supabase.ts` (service-role client, `server-only`), `lib/settings.ts` (lead → campaign → global resolver).~~

**Exit — all three met:**

| Criterion | Result |
|---|---|
| Every screen in §6 reachable and renders an empty state | ✅ Sidebar navigation (Work / Setup / System) links to all eight routes plus `/campaigns/[id]` placeholder. Each screen renders a screen-specific `<EmptyState>`. |
| No screen throws | ✅ All routes return 200 with a valid session; `/campaigns/<any-id>` renders without querying. `(app)/error.tsx`, `(app)/not-found.tsx`, and root `app/not-found.tsx` (unmatched top-level URLs) in place. |
| Supabase client unreachable from client components | ✅ `lib/supabase.ts` leads with `import 'server-only'`. `npm run verify:server-only` writes a temp `"use client"` importer, asserts the build fails citing `server-only`, and cleans up. |

**Also landed:** `lib/settings.ts` (14-key typed resolver with `react.cache`), `lib/nav.ts`, theme toggle (light/dark/system), `npm run verify:shell`.

---

#### Corrections landed after review of Phase 3 (2026-07-23)

The Phase 3 commit was solid and non-blocking — Base UI `render={…}` usage is correct, `server-only` is enforced with a negative build test, and SSR-safe patterns hold throughout. Six nits and one API-design fix landed before Phase 4:

1. **`resolveMany` applied one override set to every key.** The signature is now a per-key map (`Partial<Record<K, SettingOverrides<K>>>`); each key resolves with its own entry. `resolveSetting` and single-key `SettingOverrides<K>` are unchanged.

2. **Unmatched top-level URLs hit Next's default 404.** Root `app/not-found.tsx` reuses the branded `EmptyState` (outside `SidebarProvider`, so no sidebar chrome).

3. **`parseSettingValue` duplicate branch removed; validation comment added.** `merge.pip_scale` shares the numeric case group; a comment notes range/integer checks are deferred to the Settings write path.

4. **Dead spacer removed from `SiteHeader`.** The trailing `ml-auto` div pushed nothing.

5. **CSRF origin check failed across loopback aliases.** `checkOrigin()` now compares via `lib/origin.ts` `originsMatch()`, normalizing `localhost`, `127.0.0.1`, and `::1` to the same key so signing in at `http://localhost:3000` works when the server reports `http://127.0.0.1:3000` in `request.url` (`npm run dev` binds loopback).

No schema changes — `db push` is a no-op.

---

### Stage B — Data in

---

#### Phase 4 — Campaigns ✅ **DONE** (2026-07-23)

**Goal:** full campaign CRUD.

~~List, create (with slug derivation), detail/settings per §6.2, archive, delete with the landing-page prompt (the unpublish call itself lands in Phase 11 — until then, delete records only and say so).~~ Implemented across `lib/campaigns.ts` (data layer), `app/(app)/campaigns/*` (routes + server actions), and `components/campaigns/*` (list table, create form, and the five settings tabs — General, Intro & Merge, Landing Template, CTA, Recorder).

**Exit — all four met:**

| Criterion | Result |
|---|---|
| A campaign can be created, edited, archived, and deleted | ✅ Create (with slug derivation + auto-suffix uniqueness), General/Merge/Template/CTA/Recorder edits, archive/unarchive, and delete (records only — Phase 11 wires real unpublish, and the delete dialog says so). |
| Slug uniqueness enforced | ✅ `resolveUniqueSlug` appends `-2, -3, …` on create; edits reject a duplicate with a friendly message, backed by the DB unique constraint (`23505` mapped to "Slug is already in use"). |
| Slug locked after first deploy | ✅ `firstDeployLocked` (any `campaign_lead` with a `netlify_url`) drives a read-only field and a server-side guard that rejects a changed slug. |
| Template editor previews against a sample lead with all placeholders substituted | ✅ `substituteTemplate` fills every §5.1.1 token against the campaign's most-recent lead (or the synthetic `SAMPLE_LEAD`), rendered in a `sandbox=""` iframe. Covered by `lib/landing-template.test.ts`. |

Verified by `npm run verify:campaigns` (CRUD against a running dev server), plus clean `tsc --noEmit`, `eslint .`, and `npm test`.

#### Corrections landed after review of Phase 4 (2026-07-23)

A review found no blockers — the phase met every exit criterion with green types/lint/tests. Ten items were fixed before Phase 5 opened. The behavioural ones:

1. **The post-toast URL cleanup bounced the user off the page.** `campaign-toast.tsx` replaced the URL with a bare `"."`, which resolves relative to the current path and drops the last segment — so creating a campaign threw you off `/campaigns/{id}` and deleting threw you off `/campaigns`. Now replaces with an explicit `usePathname()`.

2. **New campaigns ignored the operator's global settings.** `createCampaign` seeded the `NOT NULL` recorder/merge columns from the hardcoded `SETTING_DEFAULTS` constants, so the `lead → campaign → global` chain never reached the global tier and the operator's tuned defaults were dropped. Now seeds from `resolveMany` over the live settings.

3. **The template preview substituted lead values without escaping.** Safe today (the preview iframe is fully sandboxed), but the same path feeds the public landing page in Phase 11. Flagged in-code as a Phase 11 requirement to HTML-escape per context before public rendering.

Also: the sample-lead query now orders DB-side by the joined `leads.updated_at` (was ordering the wrong table, then briefly fetched every row to sort in JS); the recorder viewport control shows an explicit "Custom (W×H)" option instead of silently snapping an off-preset size to 1920×1080; `formatDate` pins the `en-US` locale to avoid an SSR hydration mismatch; the delete dialog and archive toggle were extracted into a shared `DeleteCampaignDialog` and `useArchiveToggle` (the table calls the hook from a per-row subcomponent, not in a loop); and dead toast configs plus redundant inner schema re-parsing were removed.

No schema changes — Phase 4 is application code only; `supabase/migrations/` is untouched since Phase 1, so `db push` stays a no-op.

---

#### Phase 5 — Intro videos ✅ **DONE** (2026-07-23)

**Goal:** upload, normalize, assign.

~~1. `POST /api/intros` — Route Handler with `await request.formData()`, not a Server Action (`Tech.md` §4.3). 2. Stream to `LOCAL_STORAGE_ROOT/intros/`. 3. Normalize to 1080p/30fps/AAC 48kHz (`Tech.md` §9.5); extract a poster frame. 4. Probe once; cache `duration_ms`. 5. Grid UI per §6.5; campaign assignment; delete guarded when in use.~~ Implemented across `lib/video/*` (ffprobe/ffmpeg pipeline: probe, normalize, poster, and a serialized transcode lock), `lib/intros.ts` + `lib/storage.ts` + `lib/local-file.ts` (data layer, path resolution, Range-aware serving), `app/api/intros/*` (the upload Route Handler plus authenticated file/poster routes), `app/(app)/intros/*` (grid page + server actions), and `components/intros/*` (upload card, intro card, rename/assign/delete dialogs).

**Exit — all met:**

| Criterion | Result |
|---|---|
| A 50MB+ intro uploads without hitting a body limit | ✅ `experimental.proxyClientMaxBodySize: "500mb"` (verified against the installed Next 16 docs) lifts the proxy's 10MB default; `verify:intros` generates a >50MB clip and uploads it. |
| The stored file is exactly the normalized profile | ✅ The D5 filter chain yields 1920×1080 / 30fps / yuv420p / H.264 + AAC 48kHz stereo; silent sources gain an `anullsrc` track. Asserted by ffprobe in `verify:intros`. |
| `duration_ms` matches the file | ✅ Probed once from the normalized output and cached; `verify:intros` re-probes and asserts drift ≤ `INTRO_DURATION_MS_TOLERANCE` (500 ms). |
| Assigning an intro to a paused campaign resumes its jobs once Phase 7 exists | ⏳ FK write only today; resume/enqueue is deferred to Phase 7, as the criterion specifies. |

Verified by `npm run verify:intros` (upload → normalize → serve → assign/clear → delete-guard against a running dev server), plus clean `tsc --noEmit`, `eslint`, and `npm test` (55 tests).

#### Corrections landed after review of Phase 5 (2026-07-23)

A review found no blockers — the phase met every exit criterion with green types/lint/tests. Eight items were addressed; the two behavioural ones:

1. **The assign-intro dialog's checkboxes were half-wired.** It pre-checked campaigns already using the intro and let you uncheck them, but the action only ever *set* the FK — unchecking did nothing, and the schema required at least one selection. It is now a true reconcile editor: `setIntroCampaigns` sets the intro on checked campaigns and clears it on unchecked ones, guarded by `.eq('intro_video_id', introId)` so a campaign holding a *different* intro is never touched. The presented set is recomputed server-side from `listAssignableCampaigns()` rather than trusted from the client; a pure `reconcileIntroCampaignSelection` does the intersection (unit-tested).

2. **Oversized uploads failed confusingly.** Past `proxyClientMaxBodySize`, Next truncates the body silently, so a too-big file surfaced as a generic "not a video" error from ffprobe. A shared `INTRO_MAX_UPLOAD_BYTES` (500 MB) now backs a client-side size check and a server `413` (on `content-length` and `File.size`) with a clear message.

Also: `removeIfExists` was de-duplicated into `lib/local-file.ts`; a node-runtime-guarded startup sweep (`sweepStaleIntroUploadTemps`, ENOENT-tolerant per file so a boot-time race can't refuse startup) clears intro upload temps orphaned by a crash mid-normalize; the `verify:intros` duration tolerance was tightened 1500 → 500 ms and gained end-to-end reconcile assign/clear coverage; and the synchronous-normalize-under-lock tradeoff plus the poster-seek/duration coupling are now commented in the upload route.

One item was deliberately **not** taken: a max-duration guard on intros (the intro is the master clock, so a very long upload is accepted) remains a product decision, left open per instruction.

No schema changes — Phase 5 is application code only; `supabase/migrations/` is untouched since Phase 1, so `db push` stays a no-op.

---

#### Phase 6 — CSV import ✅ **DONE** (2026-07-23)

**Goal:** CSV in, `campaign_leads` rows out.

~~Parse (BOM, delimiter detection, header mapping, ragged-row rejection with 1-based line numbers), URL normalization (`Tech.md` §5.2), social-only detection → `Skipped`, global dedupe on domain-or-email with the three outcomes (§5.3), batch record with all five counts, preview-before-commit UI, persisted post-import report.~~

**Exit — all four met:**

| Criterion | Result |
|---|---|
| A 100-row CSV produces correct counts that reconcile to the row count | ✅ `verify:import` imports a generated 100-row file; the five counts (new / linked / duplicate / skipped / rejected) sum to the parsed row count. |
| Re-importing the same file into the same campaign yields 100 duplicates, 0 new | ✅ Global dedupe on domain-or-email; the second commit into the same campaign links nothing new and records 100 duplicates. |
| Importing into a *different* campaign yields 100 links, 0 new leads | ✅ Existing leads are recognized by domain/email and linked into the new campaign; no `leads` rows are created. |
| A ragged row is rejected with the line number a text editor shows | ✅ Ragged-row rejection reports 1-based line numbers matching a text editor (`Tech.md` §5.1). |

Verified by `npm run verify:import` (against a running dev server), plus clean `tsc --noEmit`, `eslint`, and `npm test`.

#### Corrections landed after review of Phase 6 (2026-07-23)

The review found the parse/dedupe/reconcile core sound (clean `tsc`, `eslint`, and the `import-parse` unit suite; `verify:import` covers every exit criterion). One blocker and several smaller items were fixed before Phase 7 opened. The substantive ones:

1. **An applied migration had been edited in place.** `20260723180000_import_commit_fn.sql` was amended to add `import_batches.exists_list`, which `db push` would silently skip on any database that already recorded that version (`DB.md` §9.2). The edit was reverted and the change re-issued as a new forward-only migration, `20260723190000_import_batches_exists_list.sql` — idempotent `ADD COLUMN IF NOT EXISTS` plus a `CREATE OR REPLACE` of `import_commit`. Verified live: the column and the corrected function are present.

2. **`import_commit` was `SECURITY DEFINER` for no reason** — the only caller holds the service role, which already bypasses RLS. Now `SECURITY INVOKER`.

3. **The "already exists in campaign X" list surfaced same-campaign duplicates.** It is now gated to genuinely *linked* rows (`AND NOT v_in_campaign`), matching the report's wording. `DB.md` §5.2 documents the `exists_list` column.

4. **The commit path could report a false failure.** A post-commit reconcile assertion and the audit-CSV move were both able to throw *after* the batch was committed, surfacing a 500 for a succeeded import. Reconcile is now preview-only; the audit-file move is best-effort (logged to `logs`, scope `importer`, never fatal).

Also: three server-rendered dates moved off raw `toLocaleString()` onto a shared `formatDateTime` (`lib/format.ts`, `en-US`) to avoid an SSR hydration mismatch — the fix Phase 4 already applied for `formatDate`; the URL scheme guard no longer misreads `host:port` as a scheme (`acme.com:8080` → `https://acme.com:8080`, unit-tested); and the mapping-change preview refresh is debounced.

---

### Stage C — The pipeline

---

#### Phase 7 — Worker and queue ✅ **DONE** (2026-07-24)

**Goal:** the state machine runs, with stub steps only — no real recording, merge, page generation, or deploy.

~~BullMQ worker with Redis liveness, two-scan boot recovery, retry/backoff, pause/resume, auto-enqueue on import, and `POST /api/leads/[id]/retry`.~~

**Exit — all five met:**

| # | Criterion | Verified by |
|---|---|---|
| 1 | Import drives leads through all four stub steps to `deployed` with `https://stub.invalid/` URLs | `verify:worker` leg 1 |
| 2 | Kill mid-run + restart writes `interrupted` and all leads still reach `deployed` (**AC-7**) | `verify:worker` leg 3 |
| 3 | No intro parks at `paused`/`merge`; assigning an intro resumes | `verify:worker` leg 2 |
| 4 | Retries respect limit and `bad_website` bucket rules | `verify:worker` leg 4 + `pipeline-retry` / `pipeline-preconditions` unit suites |
| 5 | `typecheck`, `lint`, `test` clean; `db push` a no-op | CI / manual |

No schema changes — `supabase/migrations/` untouched since Phase 6's `20260723190000_import_batches_exists_list.sql`.

---

#### Phase 8 — Recorder

**Goal:** real website recordings.

Playwright launch and context (`Tech.md` §8.1), load detection with lazy-image forcing (§8.2), cookie banner dismissal (§8.3), eased constant-velocity scroll (§8.4), before/after screenshots, probe and file placement (§8.5), full error classification (§8.6), recording reuse across campaigns, forced re-record, purged-vs-missing distinction (`Tech.md` §11).

**Exit:** 10 real websites record end to end with correct durations. A dead domain classifies as `dns_failure` and fails without retrying. A timeout classifies as `nav_timeout` and retries. A second campaign against the same lead reuses the existing recording without re-crawling.

---

#### Phase 9 — Merge

**Goal:** the final video.

Master-clock math with all three cases (`Tech.md` §9.1), the PiP filter graph (§9.2), 1080p master + 720p `+faststart` web version (§9.3), `stretch_factor` and `used_speed_floor` persisted, per-lead layout/scale overrides.

**Exit:** every output's duration equals its intro's duration, within one frame. A recording shorter than the intro triggers the speed-floor fallback and sets the flag. The bubble is circular, correctly placed, and correctly sized. Audio is the intro's only. The web version starts playing before it finishes downloading.

---

#### Phase 10 — Landing pages

**Goal:** generated HTML.

Slug generation with collision hashing (`Tech.md` §10.1), template substitution with empty-render for unknown placeholders, mobile-first poster+play markup, `noindex` + `robots.txt`, no third-party requests, HTML and SHA-1 stored.

**Exit:** a generated page renders correctly at 375px and 1920px. Every placeholder substitutes; a missing field renders empty, never a literal `{{token}}`. Two leads with identical name+city produce different slugs. The page makes exactly one external request — the video.

---

#### Phase 11 — Deploy

**Goal:** live pages.

Netlify digest deploy with a full manifest (`Tech.md` §10.3), Redis-locked serialization, `deploy_status` tracking, `netlify_url` capture, unpublish-by-omission (which completes the Phase 4 delete prompt), `dry_run` support.

**Exit:** 10 leads deploy and load at their URLs. A redeploy of 100 leads with one change uploads one file. Deleting a lead with "remove page" checked makes the URL 404. `dry_run` completes the pipeline with zero Netlify calls (**AC-6**).

---

### Stage D — The operator's surface

---

#### Phase 12 — Dashboard and realtime

Status tiles with campaign scoping, batch progress with ETA, currently-processing list, failure grouping by bucket, the `Paused – Needs Intro` banner, Realtime subscription with polling fallback.

**Exit:** status changes appear within 2 seconds without a refresh. Killing the socket falls back to polling and recovers. Counts match the database exactly under "All campaigns" and per campaign.

---

#### Phase 13 — Leads table and drawer

TanStack table per §6.3, all filters and sorts, bulk actions, and the full detail drawer including timeline, both players, per-step retry, and error display with screenshots.

**Exit:** 500 rows filter and sort without lag. The drawer plays both videos. Per-step retry re-runs exactly that step. Editing a lead's URL and re-queuing works end to end.

---

#### Phase 14 — Queue, Logs, Settings

The three remaining screens: §6.4, §6.7, §6.8. Including the worker-down indicator, log filtering with expandable traces, settings editing with env health (values never rendered).

**Exit:** stopping the worker surfaces a clear indicator within 10 seconds. Every setting is editable and takes effect without a restart. No env *value* appears anywhere in the DOM.

---

#### Phase 15 — Promote and export

Bulk `Deployed` → `Ready` promotion, and `GET /api/export` per `Tech.md` §12 — UTF-8 with BOM, defaulting to `Ready`.

**Exit:** the exported CSV opens correctly in Excel with intact accents. Every URL in it resolves (**AC-2**).

---

### Stage E — Operations

---

#### Phase 16 — Retention and cleanup

The daily repeatable job (`Tech.md` §7.5): 30-day recording purge, intermediate deletion after deploy, screenshot pruning that spares failed leads.

**Exit:** a recording older than the retention window is purged and its row updated. A step needing a purged recording re-records silently and writes a `note` event. A *missing but not purged* file fails with `missing_asset` instead.

---

#### Phase 17 — Keep-alive and docs

The GitHub Action (`Tech.md` §15) using an **insert-only anon key — never the service role key**, plus the fresh-Windows README.

**Exit:** the action inserts a heartbeat row on a manual dispatch. The service role key appears in no workflow file and no repository secret. A clean Windows machine reaches a running app from the README alone (**AC-5**).

---

#### Phase 18 — Acceptance

Run all seven criteria in §9 against a real 100-lead batch. Document every failure encountered and its recovery path. Close or explicitly defer the open items in `Tech.md` §17.

**Exit:** AC-1 through AC-7 all pass.

---

### 11.1 Phase dependency graph

```
0 ─▶ 1 ─▶ 2 ─▶ 3 ─┬─▶ 4 ─▶ 5 ─▶ 6 ─▶ 7 ─▶ 8 ─▶ 9 ─▶ 10 ─▶ 11
                  │                                          │
                  └──────────────────────────────────────────┴─▶ 12 ─▶ 13 ─▶ 14 ─▶ 15 ─▶ 16 ─▶ 17 ─▶ 18
```

Phases 0–11 are strictly sequential. **12–15 (the UI surface) may be built in parallel** with each other once 11 lands, since they share no state beyond the schema.

One useful exception: Phase 12's dashboard can be built against Phase 7's stub pipeline if UI feedback is wanted early. Nothing else may jump the queue.

---

## 12. Traceability

| Source | Where it lives |
|---|---|
| Campaign model, unit of work, dedupe, roles | §4, §5 · `DB.md` §5 |
| Pipeline semantics, retries, interruption | §7 · `Tech.md` §6–7 |
| Recording behavior | Phase 8 · `Tech.md` §8 |
| Video timing, master clock, PiP | Phase 9 · `Tech.md` §9 |
| Storage split, retention | Phase 16 · `Tech.md` §11 · `DB.md` §8 |
| Deploy, slugs, landing pages | Phases 10–11 · `Tech.md` §10 |
| Auth, env, keep-alive | Phases 2, 17 · `Tech.md` §4, §14–15 |
| Error taxonomy | §8 · `DB.md` §2.3–2.4 |
| UI stack | The callout at the top of this document · `AGENTS.md` |
| Framework corrections | `Tech.md` §1.1, §18 |
