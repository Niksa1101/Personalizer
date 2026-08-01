# Personalizer

Turn a Lead Finder CSV into personalized videos and public landing pages — one operator, one machine, loopback-only.

## Quickstart

### One-time account setup — manual, not validated by the AC-5 proxy run

These steps require a browser and cannot be exercised on a clean clone without pre-existing accounts:

1. Create a Supabase project (free tier is fine).
2. Create a **new, empty** Netlify site — see the warning at `NETLIFY_SITE_ID` in [Configure](#configure).
3. Obtain the eight `.env.local` values and the database password — see [Prerequisites](#prerequisites) and [Configure](#configure).

### Validated end-to-end

The proxy-clone run (Phase 17 AC-5) exercised this sequence in order:

```bash
git clone <repo> && cd personalizer
npm install
npx playwright install chromium
npm run verify:keepalive          # no .env.local yet — offline legs only
cp .env.example .env.local        # fill all eight + anon key (see Configure)
npx supabase login                # not validated — machine-global CLI token
npx supabase link --project-ref <your-project-ref>
npx supabase db push
npm run redis:up
npm test
npm run verify:imports
npm run seed
npm run dev                       # http://127.0.0.1:3000
# sign in with APP_PASSWORD, load /campaigns/00000000-0000-0000-0000-000000000001
npm run verify:keepalive          # full set including network legs
npm run worker                    # not exercised by the validation run — see Troubleshooting #14
```

## Prerequisites

### Install these first

| Tool | Version | Notes |
|---|---|---|
| [Node.js](https://nodejs.org/) | ≥ 20.9.0 | LTS recommended |
| [Docker Desktop](https://www.docker.com/products/docker-desktop/) | current | Required for Redis (`npm run redis:up`) |
| [Git](https://git-scm.com/) | current | |

Optional but required for in-drawer video playback: [Google Chrome](https://www.google.com/chrome/) — bundled Chromium cannot decode H.264 (`docs/Tech.md` §16.2).

### Obtain these elsewhere

| Value | Where |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase dashboard → Project Settings → API |
| `SUPABASE_SERVICE_ROLE_KEY` | Same page — **server-side only, never in GitHub secrets** |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Same page — also used as the keep-alive GitHub secret |
| `NETLIFY_SITE_ID` | Netlify → create a **new empty site** → Site configuration → Site details |
| `NETLIFY_TOKEN` | Netlify → User settings → Personal access tokens |
| `LOCAL_STORAGE_ROOT` | Choose an absolute path on your machine (see [Configure](#configure)) |
| `APP_PASSWORD` | Choose a strong password |
| `SESSION_SECRET` | Generate: `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"` |
| Database password | Supabase dashboard → Project Settings → Database — **not** an `.env.local` variable |
| Project ref | Subdomain of `NEXT_PUBLIC_SUPABASE_URL` — e.g. `abcdefghijklm` from `https://abcdefghijklm.supabase.co` |

## Configure

Copy `.env.example` to `.env.local` and fill every value.

**`NEXT_PUBLIC_SUPABASE_URL`** — project API URL, e.g. `https://abcdefghijklm.supabase.co`. Not the dashboard URL.

**`SUPABASE_SERVICE_ROLE_KEY`** — bypasses RLS on every table. Server-side only. Never commit, never put in GitHub secrets.

**`NETLIFY_SITE_ID`** — **Create a new, empty Netlify site. Do not reuse an existing one.** A deploy from this app is a full-manifest replacement: anything absent from the manifest is deleted from the site. The mass-removal floor that normally refuses a destructive sync compares against a Redis manifest cache, which is **empty on a cold start**, so it does not protect a first deploy. The Netlify token is account-wide, not site-scoped, so nothing outside `NETLIFY_SITE_ID` limits what a mistake here can reach. This app must own its site exclusively.

**`NETLIFY_TOKEN`** — personal access token with deploy rights on that site.

**`LOCAL_STORAGE_ROOT`** — absolute path to the media root, e.g. `C:\personalizer-media`. Create the directory before first run. Every write path creates missing subdirectories recursively, but nothing creates a **drive letter** that does not exist — that failure arrives at the first write, long after setup. Enable Windows long-path support: `{batch}/{lead-slug}/` with a long company name plus a collision hash approaches `MAX_PATH`.

**`REDIS_URL`** — default `redis://127.0.0.1:6379` works with `npm run redis:up`.

**`APP_PASSWORD`** — the single admin password for `/login`.

**`SESSION_SECRET`** — HS256 signing key, minimum 32 characters. Quote the value if it contains `#`.

**`NEXT_PUBLIC_SUPABASE_ANON_KEY`** — the project's anon (public) key. Not one of the eight startup variables, but required for `verify:keepalive`, `verify:dashboard`, and `verify:schema`. The same value goes into the `SUPABASE_ANON_KEY` GitHub secret for the keep-alive workflow.

## Database setup

`npx supabase login` then `npx supabase link --project-ref <your-project-ref>`, then `npx supabase db push`.

`<your-project-ref>` is the subdomain of the `NEXT_PUBLIC_SUPABASE_URL` you filled in one step ago — for `https://abcdefghijklm.supabase.co`, the ref is `abcdefghijklm`. It is not a secret; it ships in every client bundle.

**`supabase/config.toml`'s `project_id = "personalizer"` is not the ref.** It is the local project name, and passing it to `--project-ref` will fail.

`link` prompts for the **database password**. That is a prerequisite you obtain from the Supabase dashboard — **not** a ninth `.env.local` variable. Do not set `SUPABASE_DB_PASSWORD` in `.env.local`: `tsx --env-file-if-exists` and Next both load that file into processes that have no business holding a direct-Postgres credential. If the password is lost it can be reset from the dashboard; this app talks to PostgREST via supabase-js and never opens a direct Postgres connection, so `link` and `db push` are the only things a reset affects.

Link state lives in `supabase/.temp/` (gitignored). A fresh clone has no link state — `db push` alone fails with *"Cannot find project ref"* until you `link`.

## Running it

Two terminals:

```bash
npm run redis:up    # once per machine reboot if Docker stopped the container
npm run dev         # http://127.0.0.1:3000
npm run worker      # second terminal — one instance only; see Troubleshooting #14
```

On first run, campaigns default to dry-run deploy posture until you change settings. The demo campaign (`npm run seed`) is at `/campaigns/00000000-0000-0000-0000-000000000001`.

Install Playwright Chromium once: `npm run setup:browser` (or `npx playwright install chromium`).

## Authentication

Personalizer protects every lead's PII behind a **single shared password** (`APP_PASSWORD`). There are no user accounts — one session cookie (`pz_session`) means "logged in."

- **7-day absolute expiry** from login — no sliding refresh. After seven days, sign in again.
- **`npm run verify:auth` deliberately poisons the login throttle** (up to 15 minutes). **Restart the dev server** before signing in through the browser after running it.

Deep session behaviour (throttle tiers, lockout indistinguishability, origin checks) is in `docs/Tech.md` §4.

**Theme: a single dark theme, deliberately.** There is no toggle and no light mode. This is a local-only, single-operator admin tool that runs for long unattended sessions; one permanent theme removes a whole class of styling state. Do not add a theme switcher.

After sign-in, every screen is reachable from the sidebar: **Work** (Dashboard, Leads, Queue), **Setup** (Campaigns, Intro Videos, Import), **System** (Logs, Settings).

## Keep-alive

Supabase pauses inactive free-tier projects. A daily GitHub Actions cron inserts one row into `public.heartbeat` using an **insert-only anon key** — never the service role key.

### Repository secrets

Create two secrets in GitHub → Settings → Secrets and variables → Actions:

| Secret | Value |
|---|---|
| `SUPABASE_URL` | Same host as `NEXT_PUBLIC_SUPABASE_URL`, e.g. `https://abcdefghijklm.supabase.co` |
| `SUPABASE_ANON_KEY` | Same value as `NEXT_PUBLIC_SUPABASE_ANON_KEY` |

The names deliberately differ from `.env.local`: different key (`SUPABASE_ANON_KEY` vs `NEXT_PUBLIC_SUPABASE_ANON_KEY`), different trust boundary (GitHub Actions vs local machine). The anon key is constrained by RLS — insert-only on `heartbeat` with `source = 'github-action'`. **Never put `SUPABASE_SERVICE_ROLE_KEY` in a repository secret.**

### Running and confirming

- **Manual dispatch:** Actions → supabase-keepalive → Run workflow.
- **Scheduled:** daily at 06:17 UTC (`17 6 * * *`).

A **green Actions tab is not evidence the keep-alive is running.** A disabled schedule produces no runs at all, so there is nothing red to see — just nothing. GitHub disables scheduled workflows after **60 days of repository inactivity**, and this repo is expected to go quiet after Phase 18. Separately, if the anon key is rotated — or the legacy JWT key is disabled during a migration to publishable keys — the daily run starts failing against a repo nobody is watching.

Confirm periodically with `npm run verify:keepalive -- --observe`, which reads `max(id)`, `max(created_at)` and `count(*)` from `heartbeat` using the service role key. **It reads only — running it does not itself keep anything alive.**

### Manual prune (optional)

Nothing currently runs automated heartbeat retention. To prune rows older than 90 days, paste into the Supabase SQL editor (service role / dashboard):

```sql
DELETE FROM heartbeat WHERE created_at < now() - interval '90 days';
```

## Verification

Three levels:

1. **`npm test`** — pure logic, no server, no database, no `.env.local`. Runs on a fresh clone.
2. **`npm run verify:*`** — wire contracts and database behaviour against a running server (and Redis where noted).
3. **`npm run verify:*-ui`** — rendered interface in Chromium (dev server required; some legs need Google Chrome).

| Command | Purpose |
|---|---|
| `npm run dev` | Next.js app on 127.0.0.1:3000 |
| `npm run worker` | Background job worker |
| `npm run build` | Production build |
| `npm run start` | Production server on 127.0.0.1:3000 |
| `npm run seed` | Seed demo data |
| `npm run redis:up` | Start or create the `pz-redis` container |
| `npm run setup:browser` | Install Playwright Chromium |
| `npm test` | Unit tests |
| `npm run typecheck` | TypeScript check |
| `npm run lint` | ESLint |
| `npm run verify:auth` | Auth wire contract (dev server required) |
| `npm run verify:shell` | Shell route reachability (dev server required) |
| `npm run verify:imports` | Dependency and binary smoke test — catches blocked `ffmpeg-static` postinstall |
| `npm run verify:keepalive` | Keep-alive workflow + anon-key blast-radius checks |

One `verify:<phase>` script per phase — see `package.json` for the full list.

## Troubleshooting

| # | Symptom | Cause | Fix | Source |
|---|---|---|---|---|
| 1 | `db push` cannot find project ref | No link state — `supabase/.temp/` is gitignored | `npx supabase login` then `npx supabase link --project-ref <ref>` | [Database setup](#database-setup) |
| 2 | `link` asks for a password you do not have | DB password is not in `.env.local` | Reset from Supabase dashboard → Database; only `link`/`db push` need it | [Database setup](#database-setup) |
| 3 | Login fails right after `verify:auth` | Throttle poisoned up to 15 min | Restart dev server | [Authentication](#authentication) |
| 4 | Video legs fail / video will not play | Bundled Chromium cannot decode H.264 | Install Google Chrome | `docs/Tech.md` §16.2 |
| 5 | Verify legs report **skipped** | Redis down | `npm run redis:up` | [Running it](#running-it) |
| 6 | `npm run dev` will not start | **Port 3000 is the constraint.** Two clones are two Next lockfiles — not what stops a second server on the same clone | Stop the other process on 3000 | `docs/Tech.md` §16.3 |
| 7 | *"This module cannot be imported from a Client Component module"* | Missing `--conditions react-server` on a script | Add the flag per `docs/Tech.md` §16.1 | `docs/Tech.md` §16.1 |
| 8 | Clean summary, then exit `-1073740791` | Windows libuv teardown traps | Harmless — see Tech.md | `docs/Tech.md` §16.1 |
| 9 | Writes fail deep in a batch directory | `MAX_PATH` | Enable Windows long-path support | [Configure](#configure) |
| 10 | `ffmpeg_failure` on first merge / `verify:imports` red on ffmpeg | Blocked `ffmpeg-static` postinstall | `npm install-scripts approve ffmpeg-static` then re-run install | `docs/Tech.md` §16.2 |
| 11 | ENOENT on first write under `LOCAL_STORAGE_ROOT` | Drive letter does not exist | Create the path (including drive) before first run | [Configure](#configure) |
| 12 | Keep-alive Action fails 5xx | Supabase project paused | Unpause in dashboard, re-dispatch workflow | [Keep-alive](#keep-alive) |
| 13 | Actions tab shows **no runs at all** | Schedule disabled after 60 days repo inactivity | Re-enable workflow in Actions tab | [Keep-alive](#keep-alive) |
| 14 | Recordings marked purged that still exist on disk; leads reassigned or reset with no error | See verbatim entry below | Run one worker only | `worker/index.ts:52-84` |

**Symptom (entry 14).** Recordings marked purged that still exist on disk; leads reassigned or reset with no error anywhere.

**Cause.** `worker/index.ts:52-84` runs `registerLiveness()`, `startWorkerHeartbeats()`, `runBootRecovery()`, `sweepStaleRecorderTemps()`, `armCleanupScheduler()` and a conditional cleanup catch-up enqueue **before the queue worker is even constructed**. Two mechanisms cause damage. First, a second worker whose environment diverges — above all a different `LOCAL_STORAGE_ROOT` — can run Phase 16 retention against the shared database while its file deletes find nothing, marking rows purged for files that are still there. Second, any second instance joins the liveness set that `runBootRecovery()` and `startPeriodicReconcile()` reason over, changing which in-flight leads are treated as orphaned.

**Fix.** Run one worker for this project. Before starting one, confirm no other is running.

**Not a fix:** pointing the second worker at a different Redis database. That isolates the queue and leaves the damage path — the shared database — completely open. It can make things worse: with empty cleanup state in the new database, `isCleanupDue()` is *more* likely to fire, and the second worker is then the only consumer of the catch-up job it just enqueued.

**Source:** `worker/index.ts:52-84`, `worker/cleanup/job.ts:191-217`, `docs/Tech.md` §17.

## Documentation

- `docs/PRD.md` — product scope and build phases
- `docs/Tech.md` — architecture, auth, pipeline, env, keep-alive
- `docs/DB.md` — schema and migrations
