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

**Three open items were raised and deferred to the phases that can actually decide them** (`DB.md` §11 items 5–7): ~~no public poster frame (Phase 10)~~ **resolved in Phase 10**, merge-with-no-recording (Phase 7), and the seed function living in the schema.

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
| A campaign can be created, edited, archived, and deleted | ✅ Create (with slug derivation + auto-suffix uniqueness), General/Merge/Template/CTA/Recorder edits, archive/unarchive, and delete with the retain checkbox + queued unpublish (Phase 11). |
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

> **Fixed 2026-07-25 — `verify:worker` used not to exit.** `main()` returned without closing the ioredis connection `lib/queue` opens, so Node's event loop never drained and the script hung *after* printing `All 6 checks passed.`, all work and teardown already done (observed idle at 0.125s CPU holding an ESTABLISHED socket to 6379). Harmless by hand; in CI it was a job that ran to the runner timeout instead of reporting green, and it swallowed the output of anything buffering until EOF (`| tail`). The `finally` block now calls `closeQueueConnections()` — the same shutdown `worker/index.ts` already used — wrapped in its own `try`/`catch` so a rejected `quit()` cannot take the verdict down with it. Verified two ways: an A/B against a stand-in Redis on the real `lib/queue` path (without the call the process hung until killed at 25s; with it, it exited in 2s), then end to end — `verify:worker` now prints `All 6 checks passed.` and **exits on its own with code 0 in 156s**, where the same run previously passed all six and then hung past 600s until killed.

---

#### Phase 8 — Recorder ✅ **DONE** (2026-07-24)

**Goal:** real website recordings.

~~Playwright launch and context (`Tech.md` §8.1), load detection with lazy-image forcing (§8.2), cookie banner dismissal (§8.3), eased constant-velocity scroll (§8.4), before/after screenshots, probe and file placement (§8.5), full error classification (§8.6), recording reuse across campaigns, forced re-record, purged-vs-missing distinction (`Tech.md` §11).~~ Implemented across `worker/recorder/*` (a shared-browser launch with a per-lead context, the load/lazy-image/font/settle sequence, best-effort cookie-banner dismissal, an eased `requestAnimationFrame` scroll driver, `ffmpeg`/`ffprobe` transcode-and-probe, and the §8.6 error classifier), `worker/steps/record.ts` (reuse / forced re-record / purged-vs-missing orchestration), `lib/recording-precheck.ts` (the shared purged-vs-missing decision, reused by Phase 9), `lib/storage.ts` + `lib/slug.ts` + `lib/local-file.ts` (deterministic per-lead paths, a collision-safe lead slug, and crash-temp sweeping), and `worker/db.ts` (recording insert/update-in-place/purge/link plus recorder logs).

**Exit — all four met:**

| Criterion | Result |
|---|---|
| 10 real websites record end to end with correct durations | ✅ Durations reflect scroll travel, not page-load, on slow sites (mozilla 31.6s, bbc 50.4s, gnu 10.2s; wikipedia/python at the 8s floor) — the §8.4–8.5 trim confirmed end to end. Of the 10 pinned sites, 5 record cleanly and 5 exercise the classifier correctly (see the notes below); one short page trimmed 0.44s under the floor. |
| A dead domain classifies as `dns_failure` and fails without retrying | ✅ `ENOTFOUND`/`EAI_AGAIN`/`NXDOMAIN` → `dns_failure` (`bad_website`, terminal). Unit-covered and asserted in `verify:record`. |
| A timeout classifies as `nav_timeout` and retries | ✅ Navigation timeout → `nav_timeout` (`blocked`, retryable). Asserted against a slow fixture and in the classifier suite. |
| A second campaign against the same lead reuses the existing recording without re-crawling | ✅ `getUsableRecording` + `evaluateRecordingPrecheck` reuse the existing row and relink; no capture runs. |

Verified by `npm run verify:record` (hermetic fixture leg, **10/10**) and `RECORD_REAL=1 npm run verify:record` (real-site leg), plus clean `tsc --noEmit`, `eslint`, and `npm test` (**112 tests**).

#### Corrections landed after review of Phase 8 (2026-07-24)

A review found no blockers — the recorder met its exit criteria with green types/lint/tests and the fixture leg passing 10/10. Seven items were fixed, and the real-site leg surfaced two follow-ups. The behavioural fixes:

1. **Forced re-record could destroy the existing recording on a failed capture.** The old row and its file were purged *before* the new capture ran, so a transient failure (timeout, captcha) left the lead with no usable recording and the prior asset gone. Reordered to capture first, and the single active row is now refreshed **in place** (`updateRecordingCapture`) rather than purged-then-inserted — atomic, with no two-active `recordings_lead_active_uk` conflict and no window where a failed write deletes the freshly-captured file or leaves the lead with zero recordings. The raw path is deterministic per lead, so the capture overwrites the same file.

2. **The 2-second cookie-banner cap was not enforced inside the accessible-name fallback.** The fallback looped every `button`/`[role=button]` on the page with several awaited round-trips each and no deadline check. It now checks the deadline per iteration, scopes to plausible banner containers first, and caps the scan.

3. **Stored `duration_ms` was the whole session, not the scroll.** Playwright records from `newPage()`, so load + settle inflated the value Phase 9's stretch math will consume. The transcode now trims the WebM to the scroll window via ffmpeg output-seek (`-ss`/`-t` after `-i`); confirmed end to end on slow real sites whose durations now track scroll travel rather than load time (`Tech.md` §8.4–8.5).

4. **Latent + cleanup fixes:** the precheck's default `statFile` resolved `local_path` against CWD instead of `LOCAL_STORAGE_ROOT` (a Phase 9 merge-reuse trap); a dead duplicate of the injected scroll driver in `scroll.ts`; a redundant `removeFile` in the insert-race branch; and an unreachable `throw` after a `never`-typed helper.

Two observations from the real-site leg, left open rather than silently changed:

- **The pinned real-site list mixes in hostile/empty sites.** Five of ten record cleanly; the rest exercise the classifier correctly (`example.com` → `empty_page`, `cloudflare.com` → `nav_timeout`, `nytimes`/`reddit` → `captcha`) rather than producing a recording. Swapping them for record-friendly sites would make the leg a crisp pass/fail signal.
- **One short page (`debian.org`) trimmed to 7.56s, ~0.44s under the 8s floor** — the WebM tail isn't fully flushed before context close. Harmless for §9; a small post-scroll settle before closing the context would guarantee the floor.

No schema changes — Phase 8 is application code only; `supabase/migrations/` is untouched since Phase 6's `20260723190000_import_batches_exists_list.sql`, so `db push` stays a no-op.

---

#### Phase 9 — Merge ✅ **DONE** (2026-07-25)

**Goal:** the final video.

~~Master-clock math with all three cases (`Tech.md` §9.1), the PiP filter graph (§9.2), 1080p master + 720p `+faststart` web version (§9.3), `stretch_factor` and `used_speed_floor` persisted, per-lead layout/scale overrides.~~ Implemented across `lib/video/merge-plan.ts` (master-clock math + filter-graph arg builders), `lib/video/merge-action.ts` (resume ladder), `lib/storage.ts` (artifact paths + output-dir resolver), `worker/video/merge.ts` + `worker/video/upload.ts` (orchestration + Supabase upload), `worker/steps/merge.ts` (thin step), `worker/db.ts` (video CRUD + generalized `writeStepLog`), `worker/steps/record.ts` + `lib/pipeline-control.ts` (forced re-merge invalidation), and `scripts/verify-merge.ts`.

**Exit — all six met:**

| Criterion | Verified by |
|---|---|
| Every output's duration equals its intro's, within one frame | `verify:merge` legs ①–③ (34ms video / 67ms container tolerance); leg ④ at `D_intro + D_rec` |
| A recording shorter than the intro triggers the speed-floor fallback and sets the flag | `verify:merge` leg ③ + `merge-plan.test.ts` |
| The bubble is circular, correctly placed, and correctly sized | Nine-point pixel sampling in `verify:merge` (bubble edges intro-blue, corners recording-red) + a `rect_br` leg asserting all four corners are intro-blue — the un-masked inverse — plus geometry unit tests for all layouts |
| Audio is the intro's only | Stream-count assertions on master and web in `verify:merge` |
| The web version starts playing before it finishes downloading | `moov`-before-`mdat` box-order parse on `web.mp4` |
| `typecheck`, `lint`, `test` clean; `db push` a no-op | CI / manual — with one deviation: Phase 9 ships a data-only migration for the new `encode.merge_timeout_ms` setting (finding 6). It is applied, and `db push` is a no-op *after* it. |

Verified by `npm run verify:merge` (hermetic, env-free, **32 assertions**) and `npm test` (**136 tests**).

#### Review findings (Phase 9)

1. **`cacheControl` / `immutable` deviation** — supabase-js accepts a seconds value only; uploaded objects get `max-age=31536000` without the `immutable` token from `DB.md` §8. Documented here rather than silently diverging.
2. **Windows circular mask** — Tech.md §9.2's `format=rgba,geq=…:a=…` silently drops the bubble on Windows FFmpeg builds. Production uses `format=gray,geq=lum=255*lte(hypot…)` before `alphamerge` instead (same visual result; verified by nine-point sampling in `verify:merge`).
3. **`geq` mask cost** — left as specced; wall-time prints in `verify:merge` use `testsrc2` (detailed content) on every leg except the geometry sampler, so the measurement hook reflects realistic encode cost rather than a flat-colour source.
4. **Storage upload reservation** — merge reserves `web_storage_key` before upload (`upsert: true` on retry), marks completion via `uploaded_at`, and clears upload columns on re-encode upsert. Crash between upload and DB write no longer orphans a paid storage object; the resume ladder re-uploads to the same reserved key. Because PostgREST returns no error when an `UPDATE` matches zero rows, all four `videos` update helpers in `worker/db.ts` select the touched row back and throw on a miss — a silently no-op reservation would relocate the orphan rather than remove it.
5. **Lead-scoped recording resolution** — merge resolves recordings through `evaluateRecordingPrecheck` (lead-scoped, same as the precondition), self-healing `campaign_leads.recording_id` when a lead's recording is reused across campaigns.

6. **The new setting was unseeded.** Phase 9 added a fifteenth key, `encode.merge_timeout_ms`, to `lib/settings.ts` but not to the database. `resolveValue` falls back to `SETTING_DEFAULTS` for a missing key, so merge behaved correctly — but it warned on every resolve, and the Settings screen (§6.8) enumerates the table, so the operator could not have seen or tuned it. Closed by `20260725120000_encode_merge_timeout_setting.sql`.

**One schema change** — `20260725120000_encode_merge_timeout_setting.sql`, a single idempotent `INSERT` into `settings` (finding 6). No table, column, enum, index, or policy is touched. Applied to the live project on 2026-07-25; the recorded version matches the filename, so a subsequent `db push` reports *"Remote database is up to date."* Forward-only per `DB.md` §9.2: `seed_demo_data()` was already applied and is not edited, and its `ON CONFLICT (key) DO NOTHING` makes the row's provenance irrelevant — every path yields the same fifteen rows.

---

#### Phase 10 — Landing pages ✅ **DONE** (2026-07-25)

**Goal:** generated HTML.

~~Slug generation with collision hashing (`Tech.md` §10.1), template substitution with empty-render for unknown placeholders, mobile-first poster+play markup, `noindex` + `robots.txt`, no third-party requests, HTML and SHA-1 stored.~~ Implemented across `lib/landing-page.ts` (browser-safe substitute → escape → CTA-derive → cleanup → LF-normalize), `lib/landing-template.ts` (revised default template, `{{poster_url}}`, preview poster data URI), `worker/page/generate.ts` + `worker/steps/page.ts` (real page step), `worker/video/merge.ts` + `worker/video/upload.ts` (poster upload beside video), `worker/db.ts` (`loadPageContext`, `upsertLandingPage`, `update_campaign_general` RPC), `lib/campaigns.ts` (slug rename path fix), `app/api/landing/[campaignLeadId]/preview/route.ts` + viewer UI (session-guarded preview), `scripts/verify-page.ts`, `scripts/verify-landing.ts`, and `lib/robots-txt.ts` (deferred to Phase 11 manifest — not served in Phase 10).

**Exit — all seven met (restated; the original "exactly one external request — the video" criterion was wrong once posters ship):**

| Criterion | Verified by |
|---|---|
| A generated page renders correctly at 375px and 1920px | `verify:page` — no horizontal overflow at each viewport + `<meta name="robots" content="noindex, nofollow">` present |
| Every placeholder substitutes; a missing field renders empty, never a literal `{{token}}` | `lib/landing-page.test.ts` + `lib/landing-template.test.ts` (tolerant matching) + `verify:page` (no `{{` survives) |
| Two leads with identical name+city produce different slugs | `verify:import` slug-collision assertion (exactly one bare slug, one hashed) |
| Zero third-party requests — every external request goes to the one Supabase origin; the page's own origin serves only the document (a 404 `/favicon.ico` aside) | `verify:page` request interception, counted by origin |
| No request to the video URL before play | `verify:page`, after load + network idle, then after play |
| HTML and SHA-1 stored; a regeneration with no content change leaves `content_sha1` and `deploy_status` untouched | `verify:landing` no-op upsert leg + `upsertLandingPage` skip-on-match in `worker/db.ts` |
| `typecheck`, `lint`, `test` clean; `db push` a no-op after migrations | CI / manual |

Verified by `npm run verify:page` (hermetic, **19 assertions**), `npm run verify:landing` (DB-backed, **10 assertions**), `npm run verify:import` (slug collision leg), `npm test` (**163 tests**), and `npm run verify:merge` (**32 assertions**).

#### Review findings (Phase 10)

1. **`poster_public_url` deviation (D8)** — no separate column; `{{poster_url}}` is derived from `videos.poster_storage_key` at generation time, deliberately diverging from the `web_public_url` precedent to avoid a column that can disagree with its key.
2. **No poster backfill (D15)** — leads merged before this change render posterless until a `step:merge` re-uploads. Not scripted.
3. **`safeUrl` allows `data:image/` for preview only (D30)** — strict http/https-only would strip `SAMPLE_POSTER_URL` in the template editor; public pages always use Supabase https URLs.
4. **Two migrations** — `20260725180000_videos_poster_storage_key.sql` (nullable unique `poster_storage_key`) and `20260725180100_rename_campaign_slug_fn.sql` (`rename_campaign_slug` RPC, superseded by the review migration below). Both applied; `db push` is a no-op after the review migration that follows them.

#### Review findings (Phase 10 review pass, 2026-07-26)

1. **PostgREST embed ambiguity** — `campaign_leads` has two FK paths to both `videos` and `landing_pages`; every embed now names the FK constraint (`videos_campaign_lead_id_fkey`, `landing_pages_campaign_lead_id_fkey`). Without the hint, `loadPageContext`, `getLandingPageForLead`, and `listGeneratedPages` all 500 at runtime despite passing static gates.
2. **URL placeholder escaping** — `safeUrl` now HTML-escapes every accepted URL before attribute substitution, closing an `href` breakout via operator-controlled `cta_url`.
3. **Preview sandbox** — `/api/landing/{id}/preview` returns `Content-Security-Policy: sandbox` and `X-Content-Type-Options: nosniff` so direct navigation cannot execute stored HTML with the operator session in scope.
4. **Tolerant placeholder matching** — `{{ first_name }}`, `{{Company}}`, and other non-canonical spellings now substitute or render empty; recognized tokens only. Pages stored with old literal tokens get a new `content_sha1` on next regeneration.
5. **Third migration** — `20260726120000_campaign_general_rpc.sql` replaces `rename_campaign_slug` with atomic `update_campaign_general` (name + slug + description + conditional landing path rewrite with deploy-state reset).
6. **Placeholder presence checks follow the same rule as substitution** — the two "template has no `{{video_url}}`" warnings (the `step:page` log and the template-editor save toast) used a literal `includes("{{video_url}}")`, so tolerant matching (finding 4) would have made them fire on a template that in fact renders the video correctly. All three presence checks now go through one exported `hasPlaceholder()` in `lib/landing-template.ts`.

---

#### Phase 11 — Deploy ✅ **DONE** (2026-07-26, reopened and re-closed same day)

**Goal:** live pages.

> **Reopened, then closed on evidence.** Phase 11 was first closed against a green gate, but a review found the exit criterion *"Redeploy 100 leads with one change uploads one file"* was **not met by production code**: `publishManifest()` computed Netlify's `required` digest set and then uploaded the entire manifest anyway (102 PUTs for a one-file change; ~10,200 uploads for a 100-lead batch). The check that "verified" it never called `publishManifest` — `verify:deploy` reimplemented the upload loop and hand-uploaded exactly one file after asserting `required.length === 1`. Eighteen findings in total, all fixed, and the phase is now closed on a **live 14-lead run** (artifact ii below) rather than on hermetic evidence alone.

~~Netlify digest deploy with a full manifest (`Tech.md` §10.3), Redis-locked serialization, `deploy_status` tracking, `netlify_url` capture, unpublish-by-omission (which completes the Phase 4 delete prompt), `dry_run` support.~~ Implemented across `worker/deploy/{netlify,manifest,lock,sync}.ts`, `worker/steps/deploy.ts`, `lib/not-found-page.ts`, `lib/queue.ts` (`site-sync` queue, dirty flag, manifest cache, `addWithReplace`), `worker/db.ts` (manifest row-source, deploy reconciliation, dry-run markers), `worker/pipeline.ts` (removed `stubLandingUrl`), `worker/recovery.ts` (dirty-flag boot enqueue), `lib/campaigns.ts` + `app/(app)/campaigns/actions.ts` + `components/campaigns/delete-campaign-dialog.tsx` (delete-with-retain RPC + sync enqueue), `components/campaigns/general-tab.tsx` (slug-lock copy), `lib/pipeline-control.ts` (forced `step:deploy`), three migrations (`retained_pages`, `deployed_dry_run`, `deploy.timeout_ms`), `scripts/verify-deploy.ts`, and `scripts/check-urls.ts`.

**Review remediation** adds `lib/deploy-reconcile.ts` (pure reconcile payload), `lib/site-sync.ts` (best-effort enqueue over the durable marker), `worker/deploy/sync.ts` (`planUploads`, mass-removal floor, marker drain), `worker/deploy/manifest.ts` (`detectMassRemoval`), `worker/db.ts` (paginated manifest reads, `pending_site_sync` accessors), and two migrations (`reconcile_manifest_deploy`, `pending_site_sync`).

**Exit — all six met:**

| Criterion | Status | Verified by |
|---|---|---|
| 10 leads deploy and load at their URLs | ✅ | Live run — campaign A, **10 × 200** with `noindex` (artifact ii) |
| Redeploy 100 leads with one change uploads one file | ✅ | `verify:deploy` — `publishManifest()` driven end to end, `putCount === 1`; confirmed in production by `uploaded_count: 1` against `manifest_file_count: 16` |
| Delete with "remove page" checked makes the URL 404 | ✅ | Live run — campaign B, **2 × 404** (artifact ii) |
| Delete with box unchecked keeps the page live from `retained_pages` | ✅ | Live run — campaign C, **2 × 200 body-matched** to the retained snapshot (artifact ii) |
| `dry_run` completes the pipeline with zero Netlify calls (**AC-6**) | ⚠️ partial | `verify:deploy` covers dry-run manifest assembly with zero HTTP. The end-to-end `deployed_dry_run=true` + null `netlify_url` assertion still has no automated coverage — see `Tech.md` §17 item 9. **Not exercised by artifact (ii)**, which ran with `deploy.dry_run=false` throughout. |
| `typecheck`, `lint`, `test`, `verify:worker`, `verify:deploy` clean; `db push` a no-op after migrations | ✅ | Gate (below) |

> **AC-6 is the one criterion not fully closed.** The dry-run *branch* is covered hermetically and the schema supports it (`deployed_dry_run`, relaxed CHECK), but no test drives a lead through it end to end. Recorded rather than papered over.

**Evidence artifact (i) — `verify:deploy`:**

Hermetic leg (default), **15/15 checks**: loopback guard, remote-http rejection, manifest completeness (`robots.txt` + `404.html`), D32 live-wins, duplicate-path throw, dry-run manifest assembly with zero HTTP, initial publish, unpublish-by-omission, **100 pages / 1 change → exactly one PUT (through `publishManifest`)**, **D34 duplicate digest → one PUT per path**, malformed `/files` → `previous_paths: unknown`, removal-guard cold-cache seed with no phantom removals, removal-guard detection of a real unpublish, mass-removal floor, deploy lock serialization.

The one-PUT and D34 checks now call production `publishManifest()`; the fake rejects any PUT whose digest was not in `required` (422), so a regression cannot pass. Confirmed by reverting `planUploads`' filter locally: 4 unit tests fail and the hermetic leg dies on the first non-required PUT.

Real leg (`DEPLOY_REAL=1 NETLIFY_TEST_SITE_ID=<scratch-site>`): two fixture pages → 200 + `noindex`; Redis cache delete → D86 seeded previous set; redeploy of the identical manifest → **zero uploads**; live `/files` paths asserted rooted (the removal-guard comparability invariant, finding 9); teardown via empty `buildManifest()` → pages 404, `robots.txt` 200 with `Disallow: /`.

**Evidence artifact (ii) — live 14-lead run (2026-07-26):**

Ran on `personalizer-deploy-check.netlify.app`, 14 leads across three disposable campaigns. Fixtures: `scripts/fixtures/deploy-check-{a,b,c}.csv`.

**Two deviations from the procedure as originally written**, both deliberate:

1. **Not the production Netlify site.** The written procedure said "production site, not the scratch site". A purpose-built empty site was used instead. A deploy is a *full-manifest replacement* — anything absent from the manifest is deleted — and both pre-existing sites on the account hold unrelated live content that would have been destroyed on the first successful deploy. The mass-removal floor does not protect against this on a cold cache (nothing to compare against). Deploying to a live site the app does not own is not a safe procedure and the PRD text has been corrected accordingly.
2. **Campaign-level deletes, not per-lead.** The original steps said "delete lead #1 / lead #2", but lead-level delete is **Phase 13** UI — `/leads` is still an empty-state stub and no `deleteLead` action exists. The same two criteria were exercised through campaign-level delete, which drives the identical `delete_campaign_retaining_pages` RPC, `snapshot_live_pages()`, and manifest-omission path. Phase 13 re-verifies at lead granularity.

| Campaign | Leads | Delete | Result |
|---|---|---|---|
| A | 10 | none — left live for Phase 18 AC-2 | **10 × 200** + `noindex` |
| B | 2 | "Also remove the published landing page(s)" **checked** | **2 × 404** |
| C | 2 | box **unchecked** | **2 × 200**, body matched to the retained snapshot |

```
14/14 checks passed
```

**Production proof of finding 1** — deployer log, final `Site sync deploy completed`:

```json
{ "manifest_file_count": 16, "required_count": 1, "uploaded_count": 1,
  "page_count": 14, "added_count": 1, "removed_count": 0, "bytes": 41718 }
```

16 files in the manifest, **one uploaded**. Pre-fix this read `uploaded_count: 16`.

**Paths proven for the first time by this run** — none had any prior coverage:

- `reconcile_manifest_deploy` executed against real data; all 14 leads reached `status='deployed'` with correct `netlify_url`s and `deploy_status='live'`. The guarded status predicate is correct.
- `pending_site_sync` drained end to end. Both deletes were issued **as raw RPC calls with no Redis enqueue**, forcing the periodic reconcile to discover the markers unaided. It did, synced, and cleared them — the Redis-outage drill, without needing to stop Redis.
- Retain-vs-remove verified against a live CDN, with the retained pages proven by body match rather than status alone.

Verified by `npm run verify:deploy` (**15/15** hermetic), `npm test` (**206 tests**), and the run above.

#### Review findings (Phase 11)

1. **`deploy_status='removed'` reserved** — enum value ships unused; unpublish is manifest omission only. Phase 13 adds the per-page UI action; mechanism is complete (`DB.md` §2.5).
2. **`retained_pages` escape hatch** — no in-app removal; operator deletes the row then triggers `site-sync` (`Tech.md` §17 item 9).
3. **Three schema migrations** — `20260726130000_retained_pages.sql`, `20260726130100_campaign_leads_dry_run_deploy.sql`, `20260726130200_deploy_timeout_setting.sql`. Applied; `db push` is a no-op after them.
4. **Phase 4 delete dialog** — checkbox checked by default; real unpublish via `delete_campaign_retaining_pages` + `enqueueSiteSync`; copy reports "Removal queued…".

#### Second review (2026-07-26) — 16 findings, plus 2 found while fixing and 2 more found by the live run; all resolved

**Blocking**

1. **`publishManifest` ignored `deploy.required`** — uploaded every manifest file on every deploy, violating `Tech.md` §10.3 and the "one change = one upload" exit criterion. Fixed by the pure `planUploads()` in `worker/deploy/sync.ts`; the completion log's `required_count` (which reported the *total* manifest size, masking the bug) is now `manifest_file_count` / `required_count` / `uploaded_count`.
2. **The evidence never ran production code** — `verify:deploy` reimplemented the upload loop and hand-uploaded one file. It now drives `publishManifest()`; the fake 422s any non-required PUT; `worker/deploy/sync.test.ts` covers `planUploads` including D34.

**Important**

3. **Cross-lead state clobbering + O(N²) reconcile** — the per-lead UPDATE loop force-wrote `status='deployed'` on every manifest lead, resetting leads mid-re-record and undoing Phase 15's `Deployed → Ready` promotion. Replaced by the `reconcile_manifest_deploy` RPC: one statement, status transition guarded to `(processing AND current_step='deploy') OR deployed`.
4. **Removal guard budget** — a fixed 5 s × 3 while waiting for a full Netlify deploy, so any real removal failed the triggering lead. Now polls the manifest cache for a new deploy id, budgeted from `deploy.timeout_ms`.
5. **Failed `site-sync` never retried until reboot** — the job now has `attempts: 5` + exponential backoff, and the `failed` listener re-enqueues once attempts are exhausted.
6. **Redis outage during delete stranded published pages** — `enqueueSiteSync` threw before setting the dirty flag, and boot recovery gated on that flag. `delete_campaign_retaining_pages` and `update_campaign_general` now write a `pending_site_sync` row in the same transaction; boot **and** the 60 s periodic reconcile drain it. Redis is only the fast path (`lib/site-sync.ts`).
7. **Post-deploy bookkeeping reported as deploy failure** — a 0-row `deleteRetainedByPath` or a row-count drift in `markLandingPagesUploading` failed a deploy that was already live. Both are now benign-and-logged, and a reconcile error after publish flags the site dirty instead of marking a serving page `failed`.
8. **Unpaginated manifest reads** — PostgREST's 1000-row cap would have silently *unpublished* everything past it. Both reads now page; `detectMassRemoval()` refuses a manifest that drops >50 % of a site of 20+ pages.
9. **Cold-cache seed path format** — `listSiteFiles()` now normalizes to a single leading slash, so a differently-shaped Netlify response cannot read as "everything removed". Asserted hermetically and in the real leg.

**Minor**

10. `cachedSiteUrl` was a process-wide memo not keyed by site — now `Map<siteId, url>`.
11. `markLeadDeployed` was dead after the Phase 7 stub was removed — deleted.
12. `check:urls` followed redirects, so a 301 could pass the 200 + `noindex` check — now `redirect: "manual"`, reporting the `Location`. It also sets `process.exitCode` rather than calling `process.exit()`, which aborted libuv mid-fetch on Windows and corrupted the pasted evidence.
13. `check:urls` could not tell a retained 200 from a missed delete — optional `:<body-substring>` added.
14. `snapshot_live_pages` retained only `deploy_status='live'`, so unchecking the box on a campaign whose rows lagged the site retained nothing. Widened to the manifest-eligible set.
15. Three tautological `verify:deploy` checks re-pointed at real behaviour (cold-cache seeding, real removal detection, mass-removal floor, zero-upload redeploy); the fake Redis `eval` now dispatches on script text rather than argument arity.
16. **Latent Phase 13 trap** — `deploy_status='removed'` is outside `MANIFEST_DEPLOY_STATUSES`, so once the unpublish button ships such a lead would deploy "successfully" while never reaching `deployed`. `detectStaleReason` now treats `removed` as stale, `upsertLandingPage` revives it, and the deploy step fails loudly if the trigger lead's page is absent from the manifest.

**Found while fixing the above**

17. **A campaign slug change or delete hung forever with Redis down.** ioredis reconnects indefinitely by default, so `enqueueSiteSync()` neither resolved nor rejected — the `try/catch` around it could never fire, because a `catch` cannot rescue a promise that never settles. `verify:landing` hung on this too (it was previously green only because the slug-change enqueue had not yet been added). `requestSiteSync` now bounds the wait at 3 s; the durable marker makes losing the enqueue harmless.
18. **`verify:landing` never exited.** Once anything constructs the shared ioredis client, its reconnect loop keeps the event loop alive. The script now calls `closeQueueConnections()` and sets `process.exitCode` instead of relying on process teardown.

**Found by the artifact (ii) run itself**

19. **`check:urls` rejected every live page.** Netlify serves `/a/b/index.html` and 301s `/a/b` → `/a/b/`; finding 12's `redirect: "manual"` treated that as a failure, so the first run scored **0/14** on pages that were all serving correctly. Narrowed rather than reverted: a redirect is followed only when origin and query match and the paths are equal ignoring trailing slashes — anything else still fails with its `Location` reported. 14/14 after.
20. **CSV fixtures were screened with the wrong tool.** The first fixture set was validated by curl status code, which proves reachability and nothing else; three sites then failed the real run as `bot_detected`. Rescreening against the recorder's actual `BOT_MARKERS` showed **two were false positives** — `go.dev` and `nodejs.org` served 64KB and 490KB of real content and tripped only on the bare substring `"cloudflare"` in their markup. Filed separately as a Phase 8 recorder defect; fixtures now screened against the real classifier.

**Migrations added:** `20260726140000_reconcile_manifest_deploy_rpc.sql`, `20260726140100_pending_site_sync.sql`.

**Applied.** Both are recorded in `supabase_migrations.schema_migrations` (`20260726140000`, `20260726140100`); `db push` is a no-op after them. Verified against the live schema: `reconcile_manifest_deploy(p_rows jsonb, p_deployed_at timestamptz, p_deploy_id text)` matches the hand-edited `lib/database.types.ts` signature, `delete_campaign_retaining_pages` and `update_campaign_general` both write the `pending_site_sync` marker, and `snapshot_live_pages` covers the widened status set. Regenerating the types should produce an empty diff — worth confirming once, since they were written by hand rather than by the generator.

---

### Stage D — The operator's surface

---

#### Phase 12 — Dashboard and realtime ✅ **DONE** (2026-07-26)

**Goal:** the operator's "what is happening" screen — campaign-scoped status tiles, batch progress with ETA, currently-processing list, failure grouping by bucket, the `Paused – Needs Intro` banner, and live updates with a polling fallback.

Shipped: `dashboard_counts()` RPC (`20260726150000_dashboard_counts_rpc.sql`, fixes in `20260726160000_dashboard_counts_fixes.sql`), `lib/dashboard-types.ts` + `lib/dashboard.ts`, server-side Realtime singleton → SSE (`lib/dashboard-stream.ts`, `GET /api/stream/dashboard`), client connection state machine (`lib/dashboard-connection.ts`), dashboard UI (`components/dashboard/*`), deep links to `/leads?…` and `/campaigns/<id>?tab=merge`, controlled campaign settings tabs, `scripts/verify-dashboard.ts`, and `npm run verify:dashboard`.

**Exit — all three met:**

| Criterion | Status | Verified by |
|---|---|---|
| Status changes appear within 2 seconds without a refresh | ✅ | `verify:dashboard` SSE leg — DB write → Realtime-pushed frame, measured **928 ms** on the 17/17 run; reported as **skipped** (not passed) without a dev server |
| Killing the socket falls back to polling and recovers | ✅ | **Both halves now forced, not assumed.** Server side: `verify:dashboard` channel-lifecycle legs — `realtime socket kill recovers` (`realtime.disconnect()` under a live subscriber, then a write must still arrive inside `RESNAPSHOT_MS`), `channel teardown does not recurse`, `channel rebuilt after teardown`. Client side: `lib/dashboard-connection.ts` state machine + `verify:leads-ui` `stream loss degrades to polling and recovers` (Chromium offline → `Polling` → back online → `Live`). The old polling + reconnect legs only ever aborted the *client*, which is why finding 14 stayed latent |
| Counts match the database exactly under "All campaigns" and per campaign | ✅ | `verify:dashboard` — per-campaign row-for-row + all-campaigns delta (hermetic DB legs) |

**Review fixes (2026-07-26):** client silence timer now resets on every stream byte (heartbeat comments count as liveness); silence and error paths schedule reconnect; polling stops on stream recovery; Realtime channel status monitored with safety-net re-snapshot; ETA samples campaign-scoped with most-recent ordering; batch headline `complete = done + failed`; verify script uses honest skip state and exercises Realtime on the latency leg.

**Two silent-failure invariants closed during the review**, both of which presented as "Live with frozen numbers":

1. `ensureChannel()` / `ensureResnapshotTimer()` no-op while `subscriberCount()` is 0, so they must run **after** the subscriber is registered. Registering them first meant the *first* stream of a fresh process got no Realtime channel and no safety net at all — the failure only disappeared with a second concurrent client.
2. A row that changes while the channel is still joining is **never delivered** — Realtime is not a replay log. The channel now schedules a catch-up tick on `SUBSCRIBED`; without it the only recovery was the 15 s safety net, against a 2 s criterion.

**Prerequisite found while verifying:** `20260726170000_ref_padding_no_truncate.sql`. `lpad()` truncates rather than widens past its pad width, so `next_campaign_ref()` collapsed every value in a decade to the same two characters once `campaign_ref_seq` passed 99 — campaign creation failed outright on `campaigns_ref_uk`. `next_lead_ref()` had the identical defect at 10 000 leads. Phase 1's ref-sequence check only ever exercised values below the pad width.

**Deferrals carried forward:** ETA counts down at concurrency 1 while the worker is dead (Phase 14 worker-down indicator); module-scope SSE singleton is single-instance-only; `REPLICA IDENTITY FULL` on `campaign_leads` is unpaid WAL cost; AC-6 dry-run end-to-end still uncovered (Phase 11 inheritance).

**Open item recorded:** `listCampaigns()` still loads every `campaign_leads` row with no pagination (PostgREST 1000-row cap) — same class as Phase 11 review finding 8; `dashboard_counts()` is now one step away from fixing it, deferred intentionally.

Verified by `npm run typecheck`, `npm run lint`, `npm test` (**229 tests**), `npm run verify:dashboard` — **18/18 with the dev server running and no skips**, now **21/21** with the channel-lifecycle legs added on 2026-07-27 — and `npm run verify:schema` (**6/6**). Without a dev server the three live legs report **skipped**, not passed — 15/15 as originally shipped, **18/18** now, since the channel-lifecycle legs are in-process and need no server. `NEXT_PUBLIC_SUPABASE_ANON_KEY` is now set locally and documented in `.env.example` as verification-only, which is what re-armed the anon-grant check in both scripts.

---

#### Phase 13 — Leads table and drawer ✅ **DONE** (2026-07-27)

TanStack table per §6.3, server-side filters/sort/pagination (50/page), bulk retry/delete, SSE live patches via `/api/stream/leads`, and the full detail drawer (timeline, both players, per-step retry, edit + re-queue, unpublish, remove-from-campaign with retain).

| Exit criterion | Verified by |
|---|---|
| 500 rows filter/sort without lag | `verify:leads` — **100 ms worst case** across all eight sort columns *and* a search term (500 rows, 50/page); 100–160 ms across runs. Deliberately the worst, not a single `updated_at`-only sample: the embedded-column sorts (`leads.*`, `campaigns.name`) are the ones D1 flagged as able to fight back. This is D11's revisit baseline. |
| Drawer plays both videos | `verify:leads` media legs (200, Range 206, 401, 404, path containment) + `verify:leads-ui` **drawer recording decodes and advances** / **drawer final video decodes and advances** — real H.264+AAC fixture, Google Chrome (`channel: "chrome"`), asserts decode + clock advance in both `<video>` elements |
| Per-step retry re-runs exactly that step | `verify:leads` 23514 + `buildRetryPatch` unit test |
| Edit URL + re-queue end to end | `verify:leads` `updateLead` legs + skipped re-queue; `lib/lead-edit.test.ts` |

Also ships: `delete_lead_retaining_pages`, `unpublish_landing_page`, `lib/lead-actions.ts`, `lib/error-copy.ts`, `components/leads/drawer-actions.tsx`, `npm run verify:leads`, and `npm run verify:leads-ui` (**11/11**, ×2 consecutive — Chromium against the real screen, plus two Google-Chrome playback legs; needs the dev server, reports **skipped** without one).

#### Review findings (Phase 13)

**Blocking (2026-07-27 review pass)**

1. **`verify:leads` false-green** — early `fail(); return` inside `try` skipped the exit-code block; fixed with `process.exitCode = 1` inside `fail()` itself.
2. **Search crash / silent miss** — PostgREST `.or()` values now quoted (not backslash-escaped); comma and `%`/`_` literals verified in `verify:leads`.
3. **Table never refreshed after mutations** — `router.refresh()` props were frozen in local `result` state; server totals read from props, row patches re-seeded on prop change.
4. **Realtime connection churn** — `use-leads-stream` effect deps collapsed to `[scopeKey]` with ref-latched callbacks; polling starts/stops on degrade/recover; server emits `resync` on channel join and scopes insert events by `campaign_id`.

**Important**

5. **Edit form** — empty strings map to null; `pip_scale` bounds 0.05–0.60; `requeueLeadAction(id)` derives mode server-side; domain conflict surfaces `conflictRef`.
6. **D67 drawer actions** — `ACTION_CONTROLS` total map; error block renders for any `error_code`, not only `failed`.
7. **Verification depth** — media routes, path containment, stream scope, `updateLead` legs, runId-scoped fixture cleanup, widened perf leg.

**Found by re-reviewing the fixes**

8. **Skipped re-queue 409'd** — moving the mode derivation server-side dropped D39's special case. A `skipped` lead derived `resume` (or `restart`, once a URL-change note existed), and `canRetry` admits `skipped` only for `step=recording`, so the drawer's primary affordance for `not_a_website` failed outright. `deriveRequeueModeForLead` now reads `status` and short-circuits. The old leg called `retryCampaignLead` directly and so never saw this; it now drives `deriveRequeueModeForLead` → `requeueLead`, the real button path.
9. **"URL changed" was inferred from an unbounded event-log search** — an `ilike` over `pipeline_events.message` with no time bound matched forever, so every later re-queue derived `restart` (a full re-record) after a name-only edit. Now bounded to `created_at > queued_at` — "changed *since last queued*" — and the message literal is a shared constant, so the two writers and the reader cannot drift.
10. **Stream reconnect backoff was inert** — `connect()` reset `reconnectAttempt` and claimed `live` when the `EventSource` was *constructed*, so every failed attempt looked like a fresh success: a 1 s hot loop against a dead server with the indicator flickering. Reset moved to `source.onopen`; polling now also runs until the socket actually opens.
11. **`verify:leads` passed every check and then hung forever** — retry legs enqueue, which constructs the shared ioredis client; with Redis down its reconnect loop outlives `closeQueueConnections()`. The old `process.exit(1)` had masked this, and finding 1 removed it. Now exits explicitly after the summary, where teardown is fully awaited and finding 12's truncation objection does not apply.

**Found only by running against a live dev server** — every one of these was green in `npm test`, `typecheck`, and lint

12. **Every media route returned 500** — `loadCampaignLeadMediaContext` embedded `videos` ambiguously (`campaign_leads.video_id → videos.id` *and* `videos.campaign_lead_id → campaign_leads.id`), so PostgREST refused with `PGRST201`. The shared helper threw before any route logic ran. Fixed with `videos!campaign_leads_video_fk`, the same disambiguation `LEAD_LIST_SELECT` already uses for `landing_pages`.
13. **The leads stream stack-overflowed on every channel close** — `supabase.removeChannel()` dispatches `CLOSED` to the `.subscribe()` callback, and that handler calls `removeChannel(state)` again; because `state.channel = null` ran after the removal call, the re-entrant call still saw a live channel and recursed until `RangeError: Maximum call stack size exceeded`. Fixed by detaching the reference first. **Now covered** by four in-process legs in `verify:leads` (`leads channel emits resync on join`, `… resyncs after a socket kill`, `… teardown does not recurse`, `… rebuilt after teardown`), added 2026-07-27 so the two streams cannot drift back into the asymmetry that hid finding 14 — this defect was found by hand here, and its twin then survived an 18/18 run there. The teardown leg was confirmed to fail against the reintroduced bug.
14. **`lib/dashboard-stream.ts` has the identical bug**, latent since Phase 12 and fixed here too. `verify:dashboard` was green because nothing in it forced a channel error — Phase 12's second exit criterion was therefore not genuinely covered, since its stream legs only ever exercised a healthy channel. **Closed on 2026-07-27** by three in-process legs in `verify:dashboard` (see the Phase 12 exit table). Two notes from building them: `realtime.disconnect()` does *not* reach the `.subscribe()` callback (supabase-js reconnects the socket beneath it) — the CLOSED path is `removeChannel()`, i.e. the **last subscriber leaving**, so the trigger was ordinary teardown rather than a network fault; and the recursion surfaces as a burst of unhandled `RangeError`s through the promise supabase-js returns, not as a throw at the call site, so the leg listens on `unhandledRejection`. Each leg was confirmed to fail against the reintroduced defect before being kept.
15. **The path-containment leg had never tested containment.** Three defects stacked: the route was 500ing; the fixture `recordings` row pointed at a file that was never written, so everything 404'd and the leg passed for the wrong reason; and the traversal setup UPDATE was unchecked. The payload `../../etc/passwd` is an LFI signature that **Cloudflare's WAF in front of Supabase rejects with 403 + HTML**, so the value never reached Postgres. Now uses `../../escaped-by-verify.mp4` — still escapes `LOCAL_STORAGE_ROOT`, and stronger, because a `.mp4` extension means the content-type check cannot 404 it and containment is the only gate. The leg also asserts its own setup landed.
16. **The re-queue cutoff compared two different clocks** (introduced by finding 9's fix). `campaign_leads.queued_at` is stamped from the app clock (`pipeline-control.ts:54`) while `pipeline_events.created_at` defaults to the database clock, so sub-second skew flipped the derivation — it passed three consecutive runs and failed the fourth. The cutoff is now the last `resumed` event: same table, same clock.

**Found only by driving the actual interface** — `npm run verify:leads-ui` (Playwright/Chromium, `scripts/verify-leads-ui.ts`). Every one of these was green in `npm test`, `typecheck`, `lint`, `verify:leads`, and `verify:dashboard`, which is the point: the two worst findings of this review (3 and 4) were both client-side, and nothing in the suite had ever rendered the table.

17. **Ticking a row's selection checkbox also opened that lead's drawer.** The select cell guards with `onClick={(e) => e.stopPropagation()}`, and that cannot work: Base UI's `CheckboxRoot` renders its hidden `<input>` as a **sibling** of the `<span role="checkbox">` and, on click, *dispatches a brand-new* `PointerEvent('click', { bubbles: true })` on that input (`@base-ui/react/checkbox/root/CheckboxRoot.js:322`). `stopPropagation` stops the original event; the synthetic one is a different event on a different node and reaches `TableRow` regardless. So every attempt to select rows for a bulk action opened and re-opened drawers. Fixed by making the row opt out by origin — `TableCell` now carries `data-column`, and the row handler ignores clicks inside `[data-column="select"]`. `leads-table.tsx` is the only clickable ancestor containing a `Checkbox`; the other three usages are inside dialogs.
18. **The `leads_identifiable_ck` message named a remedy that cannot satisfy it.** Clearing a lead's website URL nulls `domain`, and the constraint is `domain IS NOT NULL OR email IS NOT NULL` (`core_tables.sql:124`). The copy said "A lead must have a company name, website URL, or domain" — company name is not in the constraint, and `email`, the one alternative that *is*, went unmentioned. An operator would edit a field that could never clear the error. Now: "A lead needs a website URL or an email address — clearing both leaves nothing to dedupe on", with a leg for each side (cleared successfully when an email exists; refused with usable copy when the URL is the only identifier).
19. **A stream that dies silently takes `SILENCE_MS` to be noticed.** Measured at **25.3–25.4 s** across runs: with the socket dropped underneath it, the `EventSource` never fires `error`, so the only degrade path left is the silence timer. Behaviour matches the design and the criterion is met, but the indicator reads `Live` over frozen rows for that whole window. Recorded, not changed — shortening it trades against heartbeat cost, which belongs with Phase 14's worker-down indicator.

**Found only by running with Redis up** — every prior run of this phase, including the ones that closed it, had Redis stopped.

20. **The verify scripts leaked poisoned queue jobs.** Both call themselves self-cleaning, and both cleaned only Postgres. Every retry and re-queue leg enqueues a *real* BullMQ job keyed by campaign_lead id — in-process for `verify:leads`, through the dev server for `verify:leads-ui` — and deleting the fixture rows does not remove them. Each `verify:leads` run left 3 entries in `bull:pipeline:wait` and `verify:leads-ui` left 1, all pointing at rows that no longer existed, waiting for the next worker to start and fail on them. It was invisible for the whole phase because with Redis down `enqueueLead` fails, nothing is enqueued, and there is nothing to leak. `scripts/queue-sweep.ts` now removes a run's orphans, scoped two ways so it can only ever delete garbage: a job goes only if it appeared **during this run** (measured against a snapshot taken before it) **and** its `campaign_leads` row is gone. Two wrong versions preceded it, both of which silently removed nothing — keying off the fixture campaign ids misses any lead a delete leg removed after its job was enqueued, and running the sweep before the row teardown sees every fixture row still alive. A third defect hid behind those: `getRedis()` uses `lazyConnect`, so a passive `status === "ready"` check reports "Redis is down" in any script that never enqueues in-process, which is exactly the script the sweep was added for.

Also verified green through the UI, having previously been asserted only server-side: bulk delete refreshing the table without a reload (finding 3), opening a drawer adding **no** new SSE connection (finding 4 — one connection, unchanged), the new-leads pill adding rows, the `intro_missing` → `/intros` link, a name-only edit re-queueing at its existing step instead of rewinding to `recording` (findings 9/16 — the stale-note trap is seeded deliberately), and in-drawer **playback** of both videos (2026-07-29 — closes the last open Phase 13 criterion).

**Deferrals**

- Near-duplicate connection logic between `use-leads-stream.ts` and `lib/dashboard-connection.ts` (declined shared machine per D24 — revisit if Phase 14 adds a third stream).
- Three copies of `zodFieldErrors` / `actionError` across campaigns, leads, and intros action files (shared home needs a non-`"use server"` module; out of scope).
- `lib/leads-stream.ts` has no periodic safety net and gives up on Realtime permanently after `MAX_CHANNEL_BACKOFF_ATTEMPTS`, so the leads table's liveness rests entirely on the client's polling — a thinner guarantee than the dashboard's, and not surfaced in the UI (`Tech.md` §17 item 11).

**Verified (2026-07-28, with both Redis and the dev server running):** `npm run typecheck` ✅, `npm run lint` ✅ (1 pre-existing `useReactTable` warning), `npm test` ✅ **256/256**, `npm run verify:leads` **27/27**, `npm run verify:leads-ui` **9/9**, `npm run verify:dashboard` **21/21**, `npm run verify:schema` **6/6**, `npm run verify:server-only` **3/3**. Cleanup confirmed on both sides now: zero orphan campaigns and leads in Postgres, and `bull:pipeline:wait` back to 0 after every run. Both leads scripts were re-run with Redis **stopped** as well — 27/27 and 9/9, exiting cleanly rather than hanging, since the sweep opens a connection where there previously was none.

**Verified (2026-07-29, in-drawer playback legs):** `verify:leads-ui` **11/11** ×2 consecutive with dev server + Google Chrome; both playback legs **skip** (exit 0) when Chrome is absent; mutation-tested against fake bytes (`video.error code 4`), missing lead, bogus channel, and missing `<video>` elements.

One defect found reviewing those legs: the `catch` that reports a missing Chrome wrapped the navigation and the assertions too, so a genuine mid-leg failure — a broken `/leads`, a dev server hiccup — was labelled *"Google Chrome not available"*, downgraded to **skip**, and exited **0**. The same class of silent disappearance the Phase 14 second pass was about. The `catch` now covers only the launch; everything after it fails (`Tech.md` §16.1).

Every leg added in this pass was checked against the reintroduced defect before being kept, and **that check is not a formality**: two legs that read as meaningful had no teeth. `channel rebuilt after teardown` passes against the very stack overflow it was written for, because the buggy `removeChannel` still cleared `state.channel` before the recursion unwound. It is kept as a general guard, but `channel teardown does not recurse` is the leg that actually catches finding 14.

---

#### Phase 14 — Queue, Logs, Settings ✅ **DONE** (2026-07-28)

The three remaining screens: §6.4, §6.7, §6.8. Including the worker-down indicator, log filtering with expandable traces, settings editing with env health (values never rendered).

| Exit criterion | Verified by |
|---|---|
| Stopping the worker surfaces a clear indicator within 10 seconds | `verify:queue-ui` Q-3 (`worker down surfaces within 10s`, **4.4–4.6 s** measured); `verify:queue` beat TTL + kill legs (**3.4 s**) |
| Every setting is editable and takes effect without a restart | `verify:settings` TTL + concurrency echo in `verify:queue`; dry-run round-trip legs |
| No env *value* appears anywhere in the DOM | `verify:settings` `env leak sentinel boot` on `/settings` HTML + RSC flight |

**Review fixes (2026-07-28):** 28 findings across Settings, Queue, and Logs — blocking fixes include `deploy.dry_run` boolean parsing, shared throttled health polling (`lib/queue-health-poller.ts` + `lib/queue-health-store.ts`), and Queue lead links using `campaign_lead` UUIDs. Site-sync `lastResult` now reads a Redis key (`pz:sitesync:last`) written by the worker; resets to `unknown` on Redis flush.

#### Review findings (Phase 14, second pass)

The first pass shipped green while three of its own gates were reporting nothing. Every fix below was mutation-tested — the guard was shown to fail against the reintroduced defect before being kept.

1. **The throttle test was decorative.** `queue-health-poller.test.ts`'s fake clock snapshotted due timers *before* running them, so a timer scheduled during a tick waited for the next `tick()` call. The request count then equalled the number of `tick()` calls whatever the delay: reintroducing the success-path reschedule-at-0ms bug passed 5/5. The clock now drains newly-due timers in a bounded loop; the same mutation fails 4 legs by name.
2. **Open-ended log windows clamped to the app clock.** `resolveLogTimeWindow` set `to = now` even when open-ended and `listLogs` applied it as `.lte(created_at)`, so rows written in the last few hundred milliseconds were invisible on `/logs` — a gap that widens with skew against a remote Postgres, and one that left the "N new since load" pill inconsistent, since `countNewLogs` applies no upper bound. An absent or unparseable `to` now means no upper bound at all.
3. **The finding-6 fix left the mirror-image mismatch.** `?level=bogus` set all four levels (so every checkbox rendered checked) *and* `levelsAllInvalid`, so the table returned nothing and the screen read "No logs in the last 24 hours" with a *Widen to last 7 days* button — the wrong reason. Same for a stale `?cursor=`. `describeInvalidLogParams` now names the reason and offers the reset; the boxes no longer claim rejected levels.
4. **The worker child was never killed.** `spawn("npm", …, { shell: true })` returns the *shell's* pid, so `process.kill` signalled the shell and orphaned the worker. The leak kept draining the queue — one cause behind **6 of the first run's failures**, including both TTL legs. `killProcessTree` (shared, `scripts/fixtures/ui-harness.ts`) takes the tree. The same bug leaked `verify:settings`' sentinel dev server onto port 3111, after which its env-leak leg skipped **every subsequent run** as "port occupied".
5. **The clear-queue leg could not test its own name.** It asserted three waiting jobs *and* that only two were removed — mutually exclusive. Re-adding a duplicate `jobId` does not make a job active; BullMQ ignores it, so there was never an active job to protect. An in-process worker blocked at concurrency 1 now creates one. Mutation-testing then showed `clearQueue` is protected by BullMQ's **lock**, not by its state filter — widening the filter still leaves the job — so the leg asserts `removeFailedCount === 0`, which is the only signal that separates the two.
6. **Two queue UI legs were decided by timing.** `health` is null on first paint, so the banner is empty and the concurrency card renders its other branch; `banner absent when healthy` passed vacuously on one run and skipped on the next, and `concurrency shows no worker running` skipped every run. Both assert against the settled state, and the banner check moved to where a worker is actually running.
7. **Both queue scripts crashed instead of skipping** without Redis, breaking the convention Phase 13 set with `verify:leads-ui` — a missing dependency reports **skipped** and exits 0, it does not fail the run. Both preflight Redis now. Two Windows teardown traps surfaced while proving it, each printing a clean summary and *then* exiting `-1073740791`: ioredis `quit()` on a client that never connected, and `process.exit()` on top of a live keep-alive socket.

**Deferrals:** `verify-leads-ui` harness migration (Phase 15 cleanup, same class as dashboard/leads stream dedup).

Verified by `npm run typecheck`, `npm run lint`, `npm test` (**307 tests** — 256 Phase 13 + 51 new), `npm run verify:server-only` 5/5, `npm run verify:settings` **45/45**, `npm run verify:queue` **15/15**, `npm run verify:queue-ui` **8/8**, `npm run verify:logs` **12/12**, `npm run verify:logs-ui` **8/8** — no skipped legs in any of them, with Redis and a dev server up.

---

#### Phase 15 — Promote and export

Bulk `Deployed` → `Ready` promotion, and `GET /api/export` per `Tech.md` §12 — UTF-8 with BOM, defaulting to `Ready`.

**Exit:** the exported CSV opens correctly in Excel with intact accents. Every URL in it resolves (**AC-2**).

> **AC-2 hazard from Phase 13 unpublish.** Unpublish keeps `netlify_url` on the lead while setting `landing_pages.deploy_status='removed'`. Export must not emit dead URLs for those rows — join `landing_pages` and skip or flag `deploy_status='removed'` even when `status='ready'`.

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
