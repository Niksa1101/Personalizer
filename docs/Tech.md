# Personalizer — Technical Specification

**Status:** Draft 1 — authoritative for implementation. Companions: `docs/DB.md` (schema), `docs/PRD.md` (product).
**Rule for this document:** every framework claim is quoted from the docs bundled in `node_modules/next/dist/docs/` at Next.js **16.2.10** and cited by path. Nothing here is written from memory of earlier Next.js versions.

> **Supersedes the original brief.** Four decisions override it and must not be re-derived: leads are processed **once per campaign** (not once globally); `campaign_leads` is the unit of work; the **intro video is the master clock** for video length; storage is **local-first**, with only the 720p web version reaching Supabase.

---

## 1. Stack and versions

| Layer | Choice | Version | Note |
|---|---|---|---|
| Framework | Next.js (App Router) | 16.2.10 | Pinned exact; see §1.1 |
| Runtime | React / React DOM | 19.2.4 | |
| Language | TypeScript | ^5 | **5.1+ required** |
| Node | Node.js | **≥ 20.9.0** | Hard floor, see §1.1 |
| Styling | Tailwind CSS | v4 (`@tailwindcss/postcss`) | PostCSS plugin, no `tailwind.config.js` |
| Components | shadcn/ui (preset `bKsEuMcK`) | style `base-luma` | Primitives are **`@base-ui/react` — Base UI, not Radix**. Add **all** components via `npx shadcn@latest add`; never hand-write into `components/ui/`. Icons `lucide-react`. See `AGENTS.md`. |
| Tables | TanStack Table | v8 | Leads grid |
| Database | Supabase (PostgreSQL **17**) | — | Server-side only, service role key. Draft 1 said 15; the provisioned project is 17 and nothing in `DB.md` depended on the difference. |
| Queue | BullMQ + Redis (Docker) | — | Alternative in §7.6 |
| Browser automation | Playwright (Chromium) | — | Headless |
| Video | `ffmpeg-static` | — | npm-vendored binary, no system FFmpeg |
| Auth | `jose` | — | HS256 signed session cookie |
| Deploy target | Netlify (one shared site) | — | File-digest API |

### 1.1 Next.js 16 constraint table

Each row is verified against the bundled docs. Paths are relative to `node_modules/next/dist/docs/`.

| # | Constraint | Source |
|---|---|---|
| 1 | `middleware.ts` is deprecated and **renamed to `proxy`**. | `01-app/03-api-reference/03-file-conventions/proxy.md:11` |
| 2 | Server Action request bodies are **capped at 1MB by default**. | `01-app/02-guides/server-actions.md:83` |
| 3 | Synchronous access to `cookies()`, `headers()`, `params`, `searchParams` is **fully removed**. | `01-app/02-guides/upgrading/version-16.md:298` |
| 4 | `next dev` `--hostname` **defaults to `0.0.0.0`**. | `01-app/03-api-reference/06-cli/next.md:71` |
| 5 | A custom `webpack` config makes `next build` **fail**. | `01-app/02-guides/upgrading/version-16.md:142` |
| 6 | Node.js minimum is **20.9.0**; Node 18 unsupported. | `01-app/02-guides/upgrading/version-16.md:110` |
| 7 | Route Handlers are **not cached by default**. | `01-app/01-getting-started/15-route-handlers.md:51` |
| 8 | `next dev` outputs to `.next/dev`; a **lockfile prevents multiple instances**. | `01-app/02-guides/upgrading/version-16.md:920,922` |
| 9 | `instrumentation.ts#register()` runs **once per server instance and must complete before the server is ready**. | `01-app/03-api-reference/03-file-conventions/instrumentation.md:18` |
| 10 | Server Functions are **reachable via direct POST**, not only through the UI. | `01-app/01-getting-started/07-mutating-data.md:32` |

Consequences are worked through where they bite: §4 (auth), §4.3 (uploads), §16 (dev setup).

---

## 2. System architecture

```
        ┌──────────────────────────────────────────────────────────┐
        │                    Windows workstation                    │
        │                                                          │
        │  ┌────────────────────┐        ┌──────────────────────┐  │
        │  │  Next.js app       │        │  Worker process      │  │
        │  │  (npm run dev)     │        │  (npm run worker)    │  │
        │  │  127.0.0.1:3000    │        │                      │  │
        │  │                    │        │  ┌────────────────┐  │  │
        │  │  • Admin UI        │ enqueue│  │ recorder step  │  │  │
        │  │  • Route Handlers  │───────▶│  │ merge step     │  │  │
        │  │  • proxy.ts + DAL  │        │  │ page step      │  │  │
        │  │                    │        │  │ deploy step    │  │  │
        │  └─────────┬──────────┘        │  └───────┬────────┘  │  │
        │            │                   └──────────┼───────────┘  │
        │            │      ┌────────────┐          │              │
        │            └─────▶│   Redis    │◀─────────┘              │
        │                   │  (Docker)  │  BullMQ                 │
        │                   └────────────┘                         │
        │                                                          │
        │   LOCAL_STORAGE_ROOT/                                    │
        │     {batch}/{lead-slug}/recording.mp4  ← raw, 30d TTL     │
        │     {batch}/{lead-slug}/final.mp4      ← 1080p master     │
        │     {batch}/{lead-slug}/web.mp4        ← 720p, transient  │
        │     intros/{id}.mp4                    ← normalized       │
        └───────────┬──────────────────────────┬───────────────────┘
                    │                          │
         ┌──────────▼──────────┐    ┌──────────▼──────────┐
         │      Supabase       │    │       Netlify       │
         │  • PostgreSQL (RLS) │    │  one shared site    │
         │  • Storage:         │    │  digest deploy      │
         │    lead-videos      │    │  /{camp}/{lead}     │
         │    (720p web only)  │    └─────────────────────┘
         └─────────────────────┘
```

**Two processes, deliberately.** The worker is not started by `instrumentation.ts`. That hook "is called **once** when a new Next.js server instance is initiated, and must complete before the server is ready to handle requests" (`01-app/03-api-reference/03-file-conventions/instrumentation.md:18`) — it is framed throughout as an observability hook, not a process supervisor. Starting a long-lived worker there would either block server readiness or leak a process per server instance. `npm run worker` runs alongside `npm run dev`.

Both processes talk to Supabase directly with the service role key. Neither trusts the other's memory; Redis holds queue state and PostgreSQL holds truth.

---

## 3. Repo structure

```
app/
  (auth)/login/page.tsx
  (app)/
    layout.tsx                    -- shell; calls verifySession()
    page.tsx                      -- Dashboard
    campaigns/[id]/page.tsx
    leads/page.tsx
    queue/page.tsx
    intros/page.tsx
    import/page.tsx
    logs/page.tsx
    settings/page.tsx
  api/
    login/route.ts                -- POST, sets session cookie
    logout/route.ts
    session/route.ts              -- GET; protected probe for verify:auth (§4.2)
    import/route.ts               -- POST multipart CSV      (§4.3)
    intros/route.ts               -- POST multipart video     (§4.3)
    leads/[id]/retry/route.ts
    export/route.ts               -- GET  CSV download
proxy.ts                          -- root; NOT middleware.ts  (§4.1)
instrumentation.ts                -- observability only
lib/
  dal.ts                          -- verifySession(); server-only
  session.ts                      -- jose sign/verify
  rate-limit.ts                   -- login throttle, in-memory        (§4.2)
  next-path.ts                    -- post-login redirect sanitation   (§4.5)
  supabase.ts                     -- service-role client; server-only
  env.ts                          -- startup validation of all 8 vars
  settings.ts                     -- lead → campaign → global resolution
worker/
  index.ts                        -- BullMQ worker bootstrap + boot recovery
  steps/{record,merge,page,deploy}.ts
  recorder/                       -- Playwright: launch, load, scroll, classify
  video/                          -- FFmpeg: filter graph, probe, normalize
  deploy/                         -- Netlify digest client
supabase/migrations/              -- see DB.md §9
scripts/seed.ts
```

**Module boundary that matters:** `lib/supabase.ts` and `lib/dal.ts` carry the `server-only` package import. The service role key bypasses RLS entirely (`DB.md` §7), so a single accidental client import of that module is a total data exposure. `server-only` turns that mistake into a build error.

The worker imports from `lib/` but never from `app/`. Nothing in `app/` imports from `worker/`.

---

## 4. Authentication

Single Admin, one shared password. No user table, no registration.

### 4.1 `proxy.ts`, not `middleware.ts`

> **Framework note — what changed and why.** The plan called for `middleware.ts`. In Next.js 16 the file convention is renamed: *"The `middleware` file convention is deprecated and has been renamed to `proxy`"* (`01-app/03-api-reference/03-file-conventions/proxy.md:11`). The file goes at the project root, exports a function named `proxy` (or a default export), and takes a `NextRequest` — no `edge` runtime declaration.

```ts
// proxy.ts
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

// Duplicated from lib/session.ts on purpose: proxy must not import from lib/,
// or `server-only` and `jose` get dragged into it. Keep the two in sync.
const SESSION_COOKIE_NAME = 'pz_session'

export function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname + request.nextUrl.search

  if (request.cookies.get(SESSION_COOKIE_NAME)?.value) {
    // Forward the path so the layout can rebuild `?next=` — see §4.5.
    const headers = new Headers(request.headers)
    headers.set('x-pathname', pathname)
    return NextResponse.next({ request: { headers } })
  }

  // API routes must 401 from their own handler, never redirect.
  if (request.nextUrl.pathname.startsWith('/api/')) {
    return NextResponse.next()
  }

  const url = new URL('/login', request.url)
  if (pathname && pathname !== '/') url.searchParams.set('next', pathname)
  return NextResponse.redirect(url)
}

export const config = {
  matcher: [
    '/((?!login(?:/|$)|api/login(?:/|$)|api/logout(?:/|$)|_next/static|_next/image|favicon.ico|robots.txt|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)',
  ],
}
```

> **Framework note — matcher correction (Phase 2).** The draft matcher `/((?!login|_next/static|_next/image|favicon.ico).*)` also matched `/api/login`, so the proxy redirected the login POST and the app could never be entered. **`api/login` and `api/logout` are now excluded** from the negative lookahead. Every other `/api/*` path stays matched for cookie-presence checks, but handlers still call `verifySession()` themselves — excluding `/api` wholesale is the silent-coverage-loss hazard documented in §4.2.

This check is **optimistic only**: it tests for the presence of a cookie, not its signature. It exists to redirect logged-out browsers, not to protect data.

### 4.2 The Data Access Layer is the actual boundary

Two documented facts make proxy-only auth unsafe here:

1. *"Server Functions are reachable via direct POST requests, not just through your application's UI. Always verify authentication and authorization inside every Server Function."* (`01-app/01-getting-started/07-mutating-data.md:32`)
2. *"Server Functions are not separate routes in this chain. They are handled as POST requests to the route where they are used, so a Proxy matcher that excludes a path will also skip Server Function calls on that path."* (`01-app/03-api-reference/03-file-conventions/proxy.md:217`)

> **Correction to the plan.** The plan stated this second point as *"Server Function POSTs inherit the page route's matcher, so a matcher excluding `/api` does not protect them."* The first clause is right; the conclusion is backwards. The documented hazard is the opposite direction — a matcher that **excludes** a path **also skips** Server Function calls on that path, which silently removes coverage rather than failing to exclude. The docs continue: *"A matcher change or a refactor that moves a Server Function to a different route can silently remove Proxy coverage"* (`proxy.md:219`). Either way the remedy is identical and is what we implement: verify inside every handler.

So every Route Handler and Server Action begins with `verifySession()`:

```ts
// lib/dal.ts
import 'server-only'
import { cookies } from 'next/headers'
import { cache } from 'react'
import { jwtVerify } from 'jose'

export const verifySession = cache(async () => {
  const cookieStore = await cookies()          // await required — see §4.4
  const token = cookieStore.get('pz_session')?.value
  if (!token) throw new UnauthorizedError()
  try {
    const { payload } = await jwtVerify(token, secretKey())  // HS256
    return { admin: true, expiresAt: payload.exp }
  } catch {
    throw new UnauthorizedError()
  }
})
```

`react.cache` dedupes the verification within a single render pass, so calling it in a layout and three handlers costs one verify.

The session cookie: `httpOnly`, `secure` in production, `sameSite: 'lax'`, `path: '/'`, 7-day expiry, HS256-signed with `SESSION_SECRET`. `APP_PASSWORD` is compared using a timing-safe comparison against the **validated** environment (`assertEnv()`, §14.1) rather than raw `process.env` — `passwordMatches('', '')` is `true`, so a `?? ''` fallback would turn a missing variable into an open door.

Rate limiting on `/api/login` is in-memory, with two tiers: **5 failures in 60s** or **10 in 15 minutes**. A lockout returns the same `401 invalid_credentials` as a wrong password — no `429`, no `Retry-After`, no distinguishable body — so the limiter is invisible to a caller probing it.

> **Correction landed after review (Phase 2).** This read *"5 attempts per minute per IP"*, and the implementation keyed on `x-forwarded-for` → `x-real-ip` → `'local'`. Nothing sits in front of this app (§2 — Next binds loopback directly), so those headers are never set by a proxy and are always caller-supplied: a fresh header value bought a fresh bucket and the tiers never fired. Since this limiter is the only brute-force control over the product's single credential, a bypassable one is worse than none. It is now **one global bucket, not per-IP** — which is also the honest model for a tool with exactly one operator. Do not reintroduce per-IP keying without a real reverse proxy and an explicit trusted-proxy setting.

Because the limiter is deliberately indistinguishable from a wrong password, **the client must not render a countdown.** An earlier login form tracked failures in component state and drew a timer from them; that counter reset on every reload and never decayed, so it both hid real lockouts behind a bare "Incorrect password" and invented lockouts that had already expired. The form now shows a static line saying repeated failures are throttled.

State-changing Route Handlers also call `checkOrigin()` (D44): the `Origin` header must match `request.url`'s origin. **`lib/origin.ts` `originsMatch()`** normalizes loopback aliases (`localhost`, `127.0.0.1`, `::1`) to the same key so a browser at `http://localhost:3000` is not rejected when the server bound to `127.0.0.1` reports that host.

### 4.3 Uploads go through Route Handlers, not Server Actions

> **Framework note — what changed and why.** The plan routed uploads through Server Actions. Those cap request bodies: *"Action requests are capped at 1MB by default"* (`01-app/02-guides/server-actions.md:83`). An intro video is tens of megabytes. Raising `serverActions.bodySizeLimit` would apply the higher ceiling to *every* action in the app, which is a worse trade than moving two endpoints. Route Handlers have no equivalent documented default limit and are *"not cached by default"* (`01-app/01-getting-started/15-route-handlers.md:51`), so always-fresh admin data needs no opt-out.

```ts
// app/api/intros/route.ts
export async function POST(request: Request) {
  await verifySession()                        // §4.2 — not optional
  const formData = await request.formData()
  const file = formData.get('file') as File
  // stream to LOCAL_STORAGE_ROOT/intros/, then normalize (§9.5)
}
```

CSV import (`/api/import`) uses the identical shape.

### 4.4 Async request APIs

> **Framework note — what changed and why.** *"Starting with Next.js 16, synchronous access is fully removed. These APIs can only be accessed asynchronously"* (`01-app/02-guides/upgrading/version-16.md:298`). There is no compatibility shim to fall back on — v15's temporary sync access is gone.

Every `cookies()`, `headers()`, `params` and `searchParams` is awaited. Page and handler props are typed as promises:

```ts
export default async function CampaignPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
}
```

### 4.5 Returning the operator to where they were

There are **two** ways to arrive at `/login`, and they need different machinery:

| Case | Detected by | How `next` survives |
|---|---|---|
| No cookie at all | `proxy.ts` | Built straight into the redirect URL |
| Cookie present but invalid — expired, tampered, or signed with a rotated secret | `app/(app)/layout.tsx`, via the DAL | `x-pathname` header, set by the proxy |

The second case exists because the proxy check is presence-only (§4.1) and cannot tell a valid cookie from a dead one — only `verifySession()` can. A layout receives no pathname of its own, so the proxy forwards one on the request headers, which is the mechanism the framework prescribes: *"To pass information from Proxy to your application, use headers, cookies, rewrites, redirects, or the URL"* (`proxy.md`). Every session expires after seven days, so this is the ordinary path, not an edge case.

Both sources are attacker-influenceable — a query string always, and a header because the proxy copies it out of the request URL — so **both go through one sanitizer**, `lib/next-path.ts`. A value is accepted only if it is origin-relative (`/…`), not protocol-relative (`//evil.com`, and `/\evil.com` since browsers normalize `\` to `/`), and free of control characters that could split a `Location` header. Anything else becomes `/`.

Keeping one function rather than two is the point: a second, unchecked source of a redirect target is how open redirects appear.

---

## 5. Import pipeline

`POST /api/import` — multipart, one CSV, one target campaign.

### 5.1 Parse

1. **Encoding.** UTF-8 assumed. A leading BOM (`EF BB BF`) is stripped and recorded in `import_batches.had_bom`.
2. **Delimiter detection.** Count `,`, `;` and `\t` in the header line; the highest wins. Recorded in `import_batches.delimiter`. Ties resolve to `,`.
3. **Header mapping.** Case-insensitive, whitespace- and underscore-normalized match against known aliases (`website`/`url`/`domain` → `website_url`; `company_name`/`business` → `company`; and so on). Unmapped columns are preserved verbatim in `leads.raw`.
4. **Ragged rows are rejected, not repaired.** A row whose field count differs from the header's is pushed to `import_batches.rejected_rows` as `{row, reason}` with a **1-based row number that includes the header line** — the number the Admin sees in a text editor. Parsing continues; one bad row never fails an import.

### 5.2 URL normalization

Applied in order, on `website_url`:

1. Trim; drop surrounding quotes.
2. Add `https://` when no scheme is present.
3. Lowercase the host. Leave the path alone — paths can be case-sensitive.
4. Strip tracking parameters: `utm_*`, `fbclid`, `gclid`, `msclkid`, `ref`, `mc_cid`, `mc_eid`.
5. Drop a trailing slash on a bare-host URL.
6. Store the result in `leads.website_url` **with `www.` intact**.
7. Compute `leads.domain = normalize_domain(new URL(website_url).hostname)` (`DB.md` §4.3), which additionally strips `www.`. This is the dedupe key only — the difference keeps the displayed URL faithful to the CSV while making the key stable.

> **Correction landed after review.** This step read `normalize_domain(website_url)` — the full URL — while `DB.md` §4.3 stated that only a host ever reaches the function, which stripped nothing but the scheme and `www.`. Following this document literally would have keyed `https://acme.com/about-us` as `acme.com/about-us` and silently failed to dedupe it against `/contact`. The importer now passes the host, *and* the function was hardened to cut path, query, fragment and port itself (`DB.md` §4.3). Belt and braces on the key a hundred leads per batch are matched on.

**Social-only URLs** — host matching `facebook.com`, `instagram.com`, `linkedin.com`, `twitter.com`, `x.com`, `tiktok.com`, `youtube.com`, `yelp.com`, or a known directory host — are not websites we can record. The lead is imported and its `campaign_leads` row is created with `status='skipped'`, `error_code='not_a_website'`. Importing rather than discarding keeps the row visible and countable; the Admin may later fix the URL and requeue. When a social-only URL's email matches an existing lead, the row is **linked** to that lead (not skipped) — the email identifies the same business and reuses its recording.

### 5.3 Dedupe

Global, on normalized domain **or** email, per `DB.md` §6.1. For each parsed row:

1. Look up an existing lead by `domain`, then by `email`.
2. **No match** → insert `leads` + `campaign_leads`; increment `imported_count`.
3. **Match, not in this campaign** → insert `campaign_leads` only, reusing the existing lead and its recording; increment `linked_count`. Surface *"already exists in campaign X"* in the import report — informational, not an error. Existing lead fields are **not** overwritten; the newer CSV row is **not** persisted on the lead. Provenance for this campaign membership is `campaign_leads.batch_id`.
4. **Match, already in this campaign** → skip; increment `duplicate_count`. The `UNIQUE (campaign_id, lead_id)` constraint is the backstop if a concurrent import races this check.

The Admin decides what to do about cross-campaign matches. The importer never merges records on its own.

### 5.4 Assignment and enqueue

All rows land in one `import_batches` row and one campaign. On commit, every `campaign_leads` row with `status='queued'` is enqueued (§7). Auto-enqueue is unconditional — there is no "import without processing" mode; pausing is a campaign-level concern.

---

## 6. Pipeline state machine

Two fields, per `DB.md` §2.1–2.2: `status` (coarse, for filtering) and `current_step` (fine, for resumption).

```
              import
                 │
                 ▼
            ┌─────────┐   social-only URL
            │ queued  │──────────────────▶ skipped (terminal)
            └────┬────┘
                 │ worker claims
                 ▼
         ┌───────────────┐
         │  processing   │  current_step advances:
         │               │  recording → merge → page → deploy
         └───┬───────┬───┘
             │       │
     no intro│       │ step throws
             ▼       ▼
       ┌─────────┐  ┌──────────────────┐
       │ paused  │  │ attempt_count<2? │
       │ step=   │  └────┬────────┬────┘
       │ merge   │   yes │        │ no
       └────┬────┘       ▼        ▼
            │      (backoff,   ┌────────┐
   intro    │       requeue    │ failed │
   assigned │       same step) │        │
            │                  └───┬────┘
            └──────┐               │ manual retry
                   ▼               │ (resume at current_step,
              ┌─────────┐◀─────────┘  or force full restart)
              │processing│
              └────┬────┘
                   │ deploy succeeds
                   ▼
              ┌──────────┐  Admin promotes
              │ deployed │──────────────────▶ ┌───────┐
              └──────────┘  (bulk-approvable) │ ready │
                                              └───────┘
```

### 6.1 Transition rules

| From | To | Trigger | Side effects |
|---|---|---|---|
| — | `queued` | Import | `queued_at`, `queued` event, BullMQ job |
| `queued` | `processing` | Worker claims | `started_at`, `job_runs` row, `step_started` |
| `processing` | `processing` | Step succeeds, more remain | `current_step` advances, `attempt_count` → 0 |
| `processing` | `paused` | `merge` reached, campaign has no intro | `error_code='intro_missing'`, `paused` event |
| `paused` | `queued` | Intro assigned, or manual resume | `resumed` event; re-enqueued at `merge` |
| `processing` | `processing` | Step fails, `attempt_count < limit` | `attempt_count++`, `retry_scheduled`, backoff |
| `processing` | `failed` | Step fails, retries exhausted | `error_code`, `error_detail`, `step_failed` |
| `failed` | `queued` | Manual retry | `attempt_count` → 0; resumes at `current_step` |
| `failed` | `queued` | Force full restart | `current_step` → `recording`, assets discarded |
| `processing` | `deployed` | `deploy` succeeds | `deployed_at`, `netlify_url`, `deployed` event |
| `deployed` | `ready` | Admin promotes | `promoted_at`, `promoted` event |
| any | `processing` | Boot recovery | `interrupted` event, resume at `current_step` |

**Recording runs first and is campaign-agnostic.** This is why a missing intro pauses at `merge` rather than blocking at the start: the expensive, reusable work completes regardless, and assigning an intro later costs only the merge onward.

**Per-step manual rerun.** Any single step can be re-run in isolation from the lead drawer (re-record, re-merge, regenerate page, redeploy) without disturbing the others. This is the debugging affordance; the retry paths above are the automated ones.

### 6.2 Resume semantics

`current_step` is the resume point, always. A retry re-runs the step that failed and everything after it — never anything before. Discarding prior assets is the *force full restart* path and is explicit, because re-recording is the single most expensive operation in the system.

---

## 7. Queue

### 7.1 Topology

Two BullMQ queues share one module-private `addWithReplace()` primitive (`lib/queue.ts`):

| Queue | Job | Concurrency | Job id | Purpose |
|---|---|---|---|---|
| `pipeline` | `process-lead` | `settings.queue.concurrency` (default `1`, tested to `3`) | `campaignLeadId` | Walks all four steps in one worker invocation |
| `site-sync` | `site-sync` | `1` | fixed `site-sync` | Pushes the full Netlify manifest after deletes, slug renames, or removal-guard detection |

`enqueueLead` and `enqueueSiteSync` are the **only two callers** of `addWithReplace()` — not exported, so a third caller cannot appear from outside.

The pipeline job payload is `{ campaignLeadId }` only — the worker re-reads state from PostgreSQL on pickup, so a stale queued job can never act on stale data. A single job walks all four steps in sequence within one worker invocation. Four separate queues were rejected: the steps share a working directory and large intermediate files, and splitting them buys parallelism the workstation cannot use anyway.

- **`removeOnComplete`:** pipeline `100`; site-sync `true`.
- **`removeOnFail`:** both `false`. Truth lives in `job_runs`; Redis is a work queue, not a record.
- **`attempts`/`backoff`:** site-sync retries 5 times with exponential backoff from 10 s. A dropped sync leaves deleted pages published, so it must not wait for the next worker boot; once attempts are exhausted the `failed` listener re-enqueues on a 60 s delay if the site is still dirty.

**Deploy serialization** is separate from queue concurrency: a Redis lock (`pz:deploy:lock:{NETLIFY_SITE_ID}`) plus a dirty flag (`pz:deploy:dirty:{NETLIFY_SITE_ID}`) ensure one manifest deploy at a time. The `site-sync` worker loops internally (up to 3 passes) while holding the lock.

**Two independent signals** say the site is behind the database, and recovery checks both: the Redis dirty flag (fast, lost with Redis) and `pending_site_sync` rows (durable, written in-transaction with the change — §10.3). Boot recovery and the 60 s periodic reconcile enqueue a sync if either is set.

### 7.2 Retry and backoff

`settings.queue.auto_retry_limit` (default 2) automatic attempts per step, then `failed`. Exponential backoff, base 30s: 30s, 60s. Retries are **per step**, not per job — `attempt_count` resets to 0 whenever `current_step` advances, so a lead that fails once at `recording` and once at `deploy` has not exhausted anything.

Retry policy is worker-side, not a database constraint, precisely so the limit can be raised in `settings` without a migration (`DB.md` §5.4).

### 7.3 Non-retryable failures

`bad_website` bucket errors (`dns_failure`, `http_4xx`, `parked_domain`, `not_a_website`) skip retries and go straight to `failed`. A domain that does not resolve will not resolve 30 seconds later, and burning two attempts on 100 dead leads wastes minutes for nothing. `blocked` and `system` errors retry normally.

### 7.4 Interruption recovery

Recovery uses **two scans**, not one — they answer different questions and must run in order on boot. Both share one `listOpenJobRuns()` and one `scanLiveWorkers()` per reconcile tick.

| Scan | Query | Liveness test | Writes |
|---|---|---|---|
| **Lead-status scan** (re-enqueue driver) | `campaign_leads WHERE status IN ('queued','processing')` | BullMQ `queue.getJob(id)`: `waiting`/`delayed` → live; `active` → live **iff** the worker owning the lead's open `job_runs` row still has a Redis liveness key; otherwise dead | Closes its own open run row → `interrupted`; writes the `interrupted` pipeline event; re-enqueues |
| **Run-row scan** (cleanup driver) | `job_runs WHERE state='running'` (minus rows the lead-status scan already closed) | `worker_id` has no live Redis liveness key (`pz:worker:alive:{host:pid}`, TTL 15s) | Closes row → `interrupted`. **No event** — its rows can belong to `paused`/`failed` leads with nothing to resume |

The `interrupted` event AC-7 asserts comes from the **lead-status scan**. For `waiting`/`delayed` jobs it is keyed on BullMQ alone; for `active` jobs it cross-checks the worker liveness key — instant after a graceful stop (key deleted on shutdown), **≤15s after a hard kill** (key TTL).

`finished_at` is left **NULL** on both interrupted paths (`DB.md` §5.9). `attempt_count` is untouched — interruption is free (it is not a failure). `paused` is not in either scan's status set.

A re-enqueue may be dropped while a stale job still holds its BullMQ lock (`lockDuration` 30s). Harmless: the lead stays `processing`, `claimLead` accepts `processing`, and BullMQ's stalled-check redelivery is functionally identical.

**Boot order** (before consuming):

1. Register the liveness key and start its refresh interval (every 5s).
2. Lead-status scan — no grace window.
3. Run-row scan.
4. Start consuming.

**Periodic reconcile:** every 60s while running, both scans again. The lead-status scan applies a 60s `updated_at` grace window so it does not race the `completed` listener's retry re-enqueue. A tick that is still running when the next interval fires is **skipped** (overlap guard), not stacked.

**Shutdown:** stop claiming → drain in-flight work (30s cap) → delete the liveness key → exit. A `ShutdownError` during the in-flight step leaves the run row open for boot recovery.

Partial files from a killed step are overwritten by the re-run — steps write to their final path only after success, staging through a `.tmp` sibling first.

### 7.5 Cleanup jobs

A repeatable BullMQ job, daily:

- Purge recordings older than `settings.recorder.retention_days` (30): delete the file, set `recordings.purged_at`, null `local_path`.
- Delete `videos.web_path` local copies where `uploaded_at IS NOT NULL` and the deploy succeeded.
- Prune debug screenshots older than 30 days for leads not in `failed`.

### 7.6 Alternative: a Supabase job table

Recorded because it is a live option with fewer moving parts, not a hedge.

Dropping BullMQ and Redis removes a Docker dependency and one whole class of "is Redis running?" support question. The queue becomes a claim query against `job_runs` extended with `claimed_by`, `claimed_at`, `visible_after`:

```sql
UPDATE job_runs SET claimed_by = $1, claimed_at = now()
WHERE id = (
  SELECT id FROM job_runs
  WHERE state = 'queued' AND visible_after <= now()
  ORDER BY created_at LIMIT 1
  FOR UPDATE SKIP LOCKED
) RETURNING *;
```

`FOR UPDATE SKIP LOCKED` makes this safe under concurrency. What is lost: BullMQ's backoff scheduling, repeatable jobs, and its dashboard — all reimplementable, each a small amount of code. What is gained: one less service, and queue state visible in the same database as everything else.

**Decision:** BullMQ for now, because retry/backoff and repeatable cleanup jobs come free. The switch stays cheap: `DB.md` §11.4 notes that only `job_runs` gains columns and the rest of the schema is untouched. Revisit if Redis proves to be the main setup friction on a fresh Windows machine.

---

## 8. Recorder

Playwright Chromium, headless, one visit per lead.

### 8.1 Launch and context

```ts
const browser = await chromium.launch({
  headless: true,
  args: ['--disable-blink-features=AutomationControlled', '--mute-audio',
         '--disable-dev-shm-usage', '--no-sandbox'],
})
const context = await browser.newContext({
  viewport: { width: cfg.viewportWidth, height: cfg.viewportHeight },  // 1920×1080
  userAgent: DESKTOP_CHROME_UA,       // realistic, current, no "HeadlessChrome"
  locale: 'en-US',
  deviceScaleFactor: 1,
  recordVideo: { dir: tmpDir, size: { width, height } },
})
await context.addInitScript(() => {
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
})
```

`navigator.webdriver` masking and a realistic UA reduce trivial bot detection. Nothing here defeats a real anti-bot service — sites that challenge us are classified `bot_detected` or `captcha` and reported, not fought. We visit each lead once and do not retry past a challenge.

### 8.2 Load detection

In order, capped by `nav_timeout_ms` (default 120000, per-campaign configurable):

1. `page.goto(url, { waitUntil: 'networkidle' })`
2. Force lazy images: scroll to bottom instantly, wait, scroll back to top. This triggers `IntersectionObserver`-based loaders that a top-of-page capture would otherwise film as blank boxes.
3. `document.fonts.ready`
4. Dismiss cookie banners (§8.3)
5. Settle delay: `settings.recorder.post_load_delay_ms`, default 1500ms
6. Screenshot → `screenshot_before_path`

Timeout at any point → `nav_timeout` (`blocked` bucket; retryable).

### 8.3 Cookie banner dismissal

Best-effort, capped at 2 seconds total. Try, in order: a selector list for the common CMPs (OneTrust, Cookiebot, Osano, Quantcast, Didomi, Termly), then buttons whose accessible name matches `/^(accept|allow|agree|got it|ok|i understand)/i` within a fixed-position element. First hit wins; failure is not an error. A banner that survives ends up in the video — undesirable, not fatal, and visible in the before-screenshot when someone asks why.

### 8.4 Scroll

Constant velocity with ease-in and ease-out at the ends. Uniform middle speed keeps the capture readable; the eased ends stop it looking mechanical.

```
v(t):
  0 ─────────────► ease_ms      : accelerate 0 → v_target  (ease-out cubic)
  ease_ms ──────► T - ease_ms   : hold v_target
  T - ease_ms ──► T             : decelerate v_target → 0  (ease-in cubic)
```

`ease_ms` is `settings.recorder.scroll_ease_ms` (800). Scroll is driven by `requestAnimationFrame` inside the page with an explicit per-frame delta, not `scrollIntoView` or CSS smooth scrolling — both are implementation-defined in duration and would make the capture length unpredictable, which matters because §9 has to stretch it to a known target.

Target duration is the recording's natural length: `page_height_px / v_target`, clamped to [8s, 90s]. The clamp bounds the stretch factor the merge step will face.

Playwright records from `newPage()` through load, cookie dismissal, and settle. Transcode trims the WebM to the scroll window only (`[scrollStart, scrollStart + duration]`) via ffmpeg output-seek (`-ss`/`-t` after `-i`), so stored `duration_ms` matches the scroll plan rather than the full session.

### 8.5 Post-capture

Screenshot → `screenshot_after_path`. Close the context (Playwright finalizes the video on context close, not page close — a common source of zero-byte files). Transcode the scroll window to MP4, then probe with `ffprobe` for `duration_ms`, `width`, `height`. Move from `tmpDir` to `{batch}/{lead-slug}/recording.mp4`. Insert `recordings`.

### 8.6 Error classification

| Symptom | `error_code` | Bucket | Retry |
|---|---|---|---|
| `ENOTFOUND` / `EAI_AGAIN` | `dns_failure` | bad_website | no |
| `ECONNREFUSED` | `connection_refused` | bad_website | no |
| `ERR_CERT_*` | `ssl_error` | bad_website | no |
| HTTP 404 / 410 | `http_4xx` | bad_website | no |
| HTTP 5xx | `http_5xx` | bad_website | no |
| Registrar placeholder markers | `parked_domain` | bad_website | no |
| `document.body.innerText` < 200 chars, page height ≈ viewport | `empty_page` | bad_website | no |
| Social/directory host | `not_a_website` | bad_website | no |
| Challenge markers (Cloudflare, PerimeterX, DataDome) | `bot_detected` | blocked | yes |
| reCAPTCHA / hCaptcha iframe | `captcha` | blocked | yes |
| HTTP 403 with geo markers | `geo_blocked` | blocked | yes |
| Redirected to a login route | `login_required` | blocked | yes |
| Navigation timeout | `nav_timeout` | blocked | yes |
| Playwright target crash | `browser_crash` | system | yes |

Both debug screenshots are retained for any lead ending in `failed`, and are what the drawer shows next to the error text.

---

## 9. Video

### 9.1 The master clock

**The intro's duration sets the final video's duration.** The website recording is stretched or trimmed to match. This inverts the naive approach (play the recording, overlay whatever intro fits) and is the reason final videos always end exactly when the pitch ends.

Given `D_intro` (cached in `intro_videos.duration_ms`, never re-probed) and `D_rec`:

```
stretch = D_intro / D_rec
```

| Case | Action |
|---|---|
| `stretch < 1` | Trim the recording to `D_intro`. Scroll simply doesn't finish; better than speeding up into a blur. |
| `1 ≤ stretch ≤ max_stretch` | `setpts=stretch*PTS` on the recording. |
| `stretch > max_stretch` (2.5) | **Speed-floor fallback:** stretch by exactly `max_stretch`, then freeze the final frame for the remaining `D_intro − (D_rec × max_stretch)`. |

The fallback exists because beyond ~2.5× the scroll stops reading as motion and starts reading as a stutter. A held final frame under a continuing voiceover looks intentional; a 6× crawl looks broken. Both `stretch_factor` and `used_speed_floor` are persisted (`DB.md` §5.7) so the pacing of any given video can be explained after the fact.

### 9.2 Filter graph

Recording as the base layer, intro as a circular PiP bubble. Intro audio only — the recording is muted at capture (`--mute-audio`) and carries no track worth keeping.

```
ffmpeg
  -i recording.mp4                       # [0] base
  -i intro.mp4                           # [1] overlay
  -filter_complex "
    [0:v]setpts=${stretch}*PTS,
         scale=1920:1080:force_original_aspect_ratio=increase,
         crop=1920:1080,fps=30[base];

    [1:v]scale=${pipW}:${pipH}:force_original_aspect_ratio=increase,
         crop=${pipW}:${pipH},fps=30[pipsrc];

    # circular mask: a greyscale luma disc fed to alphamerge (see below)
    color=c=black:s=${pipW}x${pipH},format=gray,
      geq=lum=255*lte(hypot(X-${cx}\,Y-${cy})\,${r})[mask];
    [pipsrc][mask]alphamerge[pip];

    [base][pip]overlay=${ox}:${oy}:shortest=0[outv]
  "
  -map "[outv]" -map 1:a
  -c:v libx264 -preset medium -crf 20 -pix_fmt yuv420p
  -c:a aac -b:a 128k -ar 48000
  -t ${D_intro_seconds}
  final.mp4
```

Where `pipW = round(1920 × pip_scale)` (default 0.20 → 384px), `pipH = pipW` for bubble layouts, `r = pipW/2`, and `(ox, oy)` derive from `merge_layout` with a 48px margin — `bubble_br` → `(1920−pipW−48, 1080−pipH−48)`.

> **The mask is greyscale-luma, not RGBA — corrected in Phase 9, do not revert.** This document originally specified `format=rgba` with `geq=r=0:g=0:b=0:a='if(lte(hypot(…),r),255,0)'`. On the Windows FFmpeg builds this project ships, that produces **no bubble at all** — the `a=` plane is silently discarded and `alphamerge` receives an opaque frame, so the merge succeeds and the output is simply wrong. `format=gray` with `lum=255*lte(…)` gives the identical visual result and works on the builds in use. Commas inside `hypot()` are backslash-escaped because they would otherwise separate filter arguments. Verified by nine-point pixel sampling in `verify:merge` (`PRD.md` §11 Phase 9, finding 2); `lib/video/merge-plan.ts` is the implementation.

`-t D_intro` is a hard truncation and the belt-and-braces guarantee that the master clock holds even if a filter misbehaves. `shortest=0` prevents the overlay from ending the output early.

Speed-floor fallback adds `tpad=stop_mode=clone:stop_duration=${hold}` to the `[base]` chain before `overlay`.

`merge_layout='fullscreen_intro'` uses a different graph entirely — `concat` rather than `overlay`, intro first, recording second — and in that mode the master-clock stretch does not apply.

### 9.3 Encode presets

| Output | Where | Settings |
|---|---|---|
| Master | Local, kept | 1080p30, x264 `preset medium`, CRF 20, AAC 128k/48kHz |
| Web | Supabase Storage | 720p30, x264 `preset medium`, **CRF 28**, **AAC 96k**, **`-movflags +faststart`** |

The web version is produced from the master in a second pass, not re-composited. `+faststart` moves the moov atom to the front so the landing page can begin playback before the file finishes downloading — without it, a cold mobile view stalls on a blank player.

Local `web.mp4` is deleted after a successful upload and deploy; the Supabase copy is canonical from then on.

Both FFmpeg runs are bounded by `settings.encode.merge_timeout_ms` (default 30 min, `DB.md` §5.12) and killed on the job's abort signal. Without a deadline a wedged FFmpeg holds its queue slot forever, which at `queue.concurrency = 1` stalls the whole batch — indistinguishable from a dead worker on the dashboard.

### 9.4 Binary

`ffmpeg-static` — the npm-vendored binary. No system FFmpeg, no PATH assumption, no "works on my machine" divergence in filter or encoder availability. `ffprobe-static` alongside it for probing.

### 9.5 Intro normalization

On upload, every intro is transcoded to a fixed profile before it is ever used: 1920×1080, 30fps, H.264 `yuv420p`, AAC 48kHz stereo. Then probed once, with `duration_ms` cached in `intro_videos`.

Normalizing up front means the merge step never branches on intro properties — no per-job resolution checks, no frame-rate mismatch artifacts in the overlay, and one probe instead of one per lead. At 100 leads per campaign that is 99 saved probes and, more importantly, one fewer thing that can differ between the first lead and the last.

---

## 10. Landing pages and deploy

### 10.1 Slugs

**Campaign slug:** from the campaign name, lowercased, non-alphanumerics → `-`, collapsed, trimmed. Unique across campaigns.

**Lead slug:** `{name}-{city}`, same transform — `acme-plumbing-portland`. Name source order: `company`, then `full_name`, then `first_name last_name`, then the email local-part, then `leads.ref` as the last resort. On collision within a campaign, append a 6-char hash of `campaign_leads.id`: `acme-plumbing-portland-a3f9c1`.

**Hash only on collision**, never by default. These URLs are pasted into outreach emails by a human and read by a recipient; `acme-plumbing-portland` earns a click that `lead-a3f9c1e2` does not.

Final path: `/{campaign-slug}/{lead-slug}` → `https://{site}.netlify.app/acme-outreach/acme-plumbing-portland`.

### 10.2 Page generation

`campaigns.landing_template` with `{{placeholder}}` substitution (`DB.md` §5.1.1). Placeholder matching is whitespace- and case-tolerant (`{{ first_name }}`, `{{Company}}` → canonical token lookup); unknown or missing placeholders render empty — never a literal `{{first_name}}`, and never a failed deploy.

Requirements the template must satisfy:

- **Mobile-first.** Most recipients open outreach on a phone.
- **Poster + play button**, not autoplay. `<video>` with `poster`, `preload="none"`, `playsinline`, `controls`. Autoplay is blocked on mobile anyway, and a poster frame loads far faster than a video header. When no poster URL is available, the generator strips an empty `poster=""` and downgrades to `preload="metadata"` — a deliberate fallback that opens a video connection before play; leads merged before Phase 10 stay in this state until a `step:merge` uploads a poster.
- `<meta name="robots" content="noindex, nofollow">`, reinforced by a site-level `robots.txt` `Disallow: /`. These pages name individual businesses and must not be indexed.
- **No tracking.** No analytics, no pixels, no third-party requests. Every external fetch goes to the one Supabase origin (poster on load, video on play). A 404 `/favicon.ico` from the page's own origin is expected.
- Self-contained: inline CSS, no CDN dependencies.

Rendered HTML is stored in `landing_pages.html` with its SHA-1 in `content_sha1`.

### 10.3 Netlify digest deploy

Netlify's file-digest API takes a **full manifest** of the site and responds with only the digests it is missing. The manifest is assembled in `worker/deploy/manifest.ts` from live `landing_pages`, `retained_pages` snapshots, and site files (`robots.txt`, `404.html`).

```
POST /api/v1/sites/{site_id}/deploys
  { "files": { "/campaign-a/lead-1/index.html": "<sha1>",
               "/campaign-a/lead-2/index.html": "<sha1>",
               "/robots.txt": "<sha1>",
               "/404.html": "<sha1>" } }
→ { "id": "deploy_id", "required": ["<sha1>", ...] }

PUT /api/v1/deploys/{deploy_id}/files/{path}     # once per path, even when digests repeat (D34)
```

Sending the complete manifest each time is what makes this safe: the manifest **is** the desired state of the site, so a page that was deployed but is now absent from the manifest gets removed, and nothing drifts. Because `required` only ever contains changed digests, redeploying 100 leads to change one costs one small upload.

**Only `required` digests are uploaded.** `planUploads(files, required)` in `worker/deploy/sync.ts` is the single place that decides — the unit is the *path*, not the digest, so two leads whose HTML is byte-identical share one digest but are still two PUTs (D34). Uploading the whole manifest defeats the protocol entirely and is what the "100 pages / 1 change → one PUT" check in `verify:deploy` exists to catch; the fake Netlify server rejects any PUT whose digest was not required (422) so the check cannot pass vacuously. Every completed deploy logs `manifest_file_count`, `required_count` and `uploaded_count` — the operator-visible proof.

**Truncation is indistinguishable from deletion**, so a manifest that would drop more than half of a site of 20+ published paths is refused (`detectMassRemoval`) rather than deployed. The two manifest reads paginate explicitly for the same reason: PostgREST's default 1000-row cap would silently unpublish everything past it.

**Unpublishing** is therefore just a deploy whose manifest omits the page. Campaign delete with "Also remove the published landing page(s)" checked enqueues `site-sync`; the worker pushes the updated manifest. With the box unchecked, live pages are snapshotted into `retained_pages` first (`delete_campaign_retaining_pages` RPC) and stay in the manifest after the campaign row is gone.

**A queued unpublish cannot be lost.** Redis is the fast path, not the record: `delete_campaign_retaining_pages` and `update_campaign_general` insert a `pending_site_sync` row **in the same transaction** as the destructive change. If Redis is unreachable the enqueue is logged and swallowed (`lib/site-sync.ts`), and boot recovery plus the 60 s periodic reconcile drain the table. Markers are cleared only up to the watermark of the deploy that satisfied them, so a change made *during* a sync survives it.

> The enqueue is bounded at 3 s and never awaited unboundedly. ioredis reconnects forever by default, so an enqueue against a down Redis *hangs* rather than throwing — a `try/catch` is no protection against a promise that never settles, and the operator's delete would block indefinitely. Any web-request path that touches the queue needs the same treatment.

**Post-deploy bookkeeping never fails a live deploy.** Once Netlify reports ready, the pages are serving; a reconcile error after that point flags the site dirty and queues a `site-sync` rather than marking a serving page `failed`. The deploy lock does not cover other leads' `page` steps, so row-status drift between the manifest read and the status update is expected and logged, not fatal.

Deploys are **serialized** — one in flight at a time, guarded by a Redis lock and a manifest-hash cache (`pz:deploy:manifest:{NETLIFY_SITE_ID}`). Concurrent deploy attempts wait up to ~60s, then fail with `netlify_failure`.

**Removal guard.** A lead's deploy that would drop paths hands the unpublish to `site-sync` and waits for it, since only `site-sync` is authorised to remove. It waits by polling the manifest cache for a *new* deploy id, budgeted from `deploy.timeout_ms` (default 300 000 ms) — the thing being waited on is a full Netlify deploy, so a short fixed budget would fail the triggering lead every time a page was genuinely removed.

**Dry run:** `settings.deploy.dry_run` runs the entire pipeline including HTML generation and manifest assembly/validation, then skips every Netlify call (no lock, no cache, no HTTP). The lead reaches `status='deployed'` with `deployed_dry_run=true` and a null `netlify_url` (`DB.md` §5.4); `landing_pages.deploy_status` stays `pending`. A later real deploy clears the flag and writes the URL.

**Verification:** `npm run verify:deploy` (hermetic fake Netlify by default; `DEPLOY_REAL=1` + scratch site for the real leg). No Redis required — the lock leg uses an in-process fake.

Production URL checks: `npm run check:urls -- <url> <status>[:<body-substring>] …`. 200 responses must include `noindex`. Redirects are **not** followed — a 301 means the URL under test is not serving the page, and following it would let an unrelated 200 pass. The optional percent-encoded body substring is what distinguishes a page served from `retained_pages` from one the delete simply missed.

---

## 11. Storage lifecycle

| Artifact | Location | Retention |
|---|---|---|
| Raw recording | Local `{batch}/{lead-slug}/recording.mp4` | **30 days**, then purged |
| 1080p master | Local `{batch}/{lead-slug}/final.mp4` | Indefinite |
| 720p web (local) | Local `{batch}/{lead-slug}/web.mp4` | Deleted after upload + deploy |
| 720p web (remote) | Supabase `lead-videos/{uuid}/final.mp4` | Indefinite |
| Poster (local) | Local `{batch}/{lead-slug}/poster.jpg` | Indefinite — admin thumbnail |
| Poster (remote) | Supabase `lead-videos/{uuid}/poster.jpg` | Indefinite — `cacheControl: 31536000` (unique-per-encode, same as video) |
| Intro (normalized) | Local `intros/{id}.mp4` | Indefinite |
| Debug screenshots | Local `{batch}/{lead-slug}/*.png` | 30 days, kept for `failed` |
| Landing HTML | PostgreSQL `landing_pages.html` | Indefinite |

All local paths are stored **relative to `LOCAL_STORAGE_ROOT`** (`DB.md` §3), so moving the storage root is an env change rather than a migration.

**Missing asset handling.** Before each step, verify its inputs exist:

- Recording missing **with** `purged_at` set → expected. Silently re-record, write a `note` event ("raw recording had been purged; re-recorded automatically"). No Admin action.
- Recording missing **without** `purged_at` → the file was moved or deleted out from under us. Fail with `missing_asset` and offer a re-record.
- Master or intro missing → `missing_asset`, no automatic recovery. Both are supposed to be permanent; their absence means something is wrong that a silent re-run would paper over.

The distinction is the whole point: purging is our own scheduled behavior and should be invisible; unexpected absence is a signal.

> **Resolved in Phase 7.** When `merge` is reached and the campaign has an intro but no usable `recordings` row (never recorded, or only purged/failed rows remain), the worker sets `current_step='recording'`, writes a `note` event, and continues the walk — record-first-and-continue, **at most once per job**. A second arrival at `merge` without a usable recording proceeds and lets the real merge step (Phases 8–11) raise `missing_asset`. Phase 7's merge stub succeeds, so the redirect self-corrects. Pausing for a missing intro (`intro_missing`) is unchanged.

---

## 12. Export

`GET /api/export?campaign={id}&status=ready` → CSV, UTF-8 with BOM (Excel opens it correctly).

| Column | Source |
|---|---|
| `ref` | `leads.ref` (`LD-0042`) |
| `first_name`, `last_name`, `full_name` | `leads` |
| `company`, `email`, `phone` | `leads` |
| `website_url`, `city`, `state`, `country`, `industry` | `leads` |
| `campaign` | `campaigns.name` |
| `campaign_ref` | `campaigns.ref` |
| `landing_url` | `campaign_leads.netlify_url` |
| `video_url` | `videos.web_public_url` |
| `status` | `campaign_leads.status` |
| `deployed_at`, `promoted_at` | ISO 8601 UTC |

Defaults to `status='ready'` — the handoff to outreach is reviewed leads only. Other statuses are exportable for inspection but that is not the primary path.

---

## 13. Logging and observability

Two streams, deliberately separate:

- **`pipeline_events`** — operator-facing timeline for one lead. Short, human-readable, rendered in the drawer. Written at every state transition.
- **`logs`** — system-facing. Stack traces, FFmpeg stderr, Netlify responses, Playwright diagnostics. Scoped (`importer`/`recorder`/`merger`/`deployer`/`web`/`worker`) and correlated by `campaign_lead_id` and `job_run_id` where applicable.

An operator should never need `logs` to understand *what* happened — only to understand *why*. If a failure is unexplained without a stack trace, the `error_detail` on `campaign_leads` is not doing its job.

FFmpeg stderr is captured in full for failed encodes and truncated to the last 4KB for successful ones. Realtime: the dashboard subscribes to `pipeline_events` and `campaign_leads` via Supabase Realtime, with a 5-second polling fallback when the socket drops.

---

## 14. Configuration

### 14.1 Environment — all eight

`.env.example` (specified here; **not written to disk in this phase**):

```bash
NEXT_PUBLIC_SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
NETLIFY_SITE_ID=
NETLIFY_TOKEN=
LOCAL_STORAGE_ROOT=
REDIS_URL=
APP_PASSWORD=
SESSION_SECRET=
```

`lib/env.ts` validates all eight at startup, in both the Next process and the worker, and **refuses to boot** if any is missing or empty — with a message naming every missing variable at once, not just the first. A half-configured system that starts and then fails on lead 40 wastes far more time than one that refuses to start.

**Test-only (not in `lib/env.ts`):** `NETLIFY_TEST_SITE_ID` — read directly from `process.env` by `scripts/verify-deploy.ts` for the `DEPLOY_REAL=1` leg only. Never required for normal operation; keeps "all eight" literally true.

Additionally, set **`NEXT_SERVER_ACTIONS_ENCRYPTION_KEY`** in production: closure variables in inline actions are encrypted, and *"For multi-instance and self-hosted deployments, set `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` to a stable key shared across instances"* (`01-app/02-guides/server-actions.md:85`). Without it the key is generated per build, so a restart breaks clients holding in-flight action references. It is not in the eight because it is deployment hygiene rather than app configuration.

`NEXT_PUBLIC_SUPABASE_URL` carries the `NEXT_PUBLIC_` prefix by Supabase convention. Note that the **service role key deliberately does not** — it must never reach a client bundle (§3).

### 14.2 Settings resolution

**Lead override → campaign value → global `settings` default.** Null means inherit, which is why override columns are nullable rather than defaulted (`DB.md` §5.4). `lib/settings.ts` exposes `resolveSetting` (single key) and `resolveMany` (batch, with a **per-key** override map); no other module reads `settings` directly.

### 14.3 `next.config.ts`

> **Framework note — what changed and why.** Keep this file **webpack-free**. Turbopack is the default builder in 16, and *"If your project has a custom `webpack` configuration and you run `next build` (which now uses Turbopack by default), the build will **fail** to prevent misconfiguration issues"* (`01-app/02-guides/upgrading/version-16.md:142`). This matters if shadcn or Tailwind tooling ever suggests a webpack tweak — the escape hatches are `--webpack` to opt out or `--turbopack` to ignore the config (`version-16.md:146,160`), but the right answer for this project is not to add one.

Also **do not enable `cacheComponents`** (the PPR successor). Every screen in this tool is dynamic, per-request admin data; the caching machinery is pure overhead with nothing to cache.

---

## 15. Keep-alive

Supabase pauses inactive free-tier projects. A GitHub Actions cron writes one row daily:

```yaml
name: supabase-keepalive
on:
  schedule: [{ cron: '17 6 * * *' }]
  workflow_dispatch:
jobs:
  ping:
    runs-on: ubuntu-latest
    steps:
      - run: |
          curl -sS -X POST "$SUPABASE_URL/rest/v1/heartbeat" \
            -H "apikey: $SUPABASE_ANON_KEY" \
            -H "Authorization: Bearer $SUPABASE_ANON_KEY" \
            -H "Content-Type: application/json" \
            -H "Prefer: return=minimal" \
            -d '{"source":"github-action"}' --fail
        env:
          SUPABASE_URL: ${{ secrets.SUPABASE_URL }}
          SUPABASE_ANON_KEY: ${{ secrets.SUPABASE_ANON_KEY }}
```

`Prefer: return=minimal` is explicit because the key has **no `SELECT` privilege at all** — asking PostgREST to echo the inserted row back would fail on the read, not the write. PostgREST has defaulted to `minimal` on `POST` since v9, so this is belt-and-braces rather than a fix (verified against the live project: `201`), but relying on a server-side default for the one call that keeps the database alive is not worth the saving.

**The service role key must never enter GitHub secrets.** It bypasses RLS on every table (`DB.md` §7); a leak there is total exposure of every lead. The anon key used here is constrained by the insert-only policy on `heartbeat` (`DB.md` §7.3) — no `SELECT`, no `UPDATE`, no `DELETE`, and `WITH CHECK (source = 'github-action')` pins even what it can write. Worst case, someone adds rows to a table whose only purpose is to be written to.

That bound is now real rather than aspirational: `DB.md` §8.1 removed a storage policy that would have let this same key list every video in the bucket, and §7.1.1 revoked the table privileges Supabase grants `anon` by default. Both were found by measuring what the key could actually do, which is worth repeating whenever its scope changes.

The `17 6 * * *` minute offset avoids the top-of-hour spike when every scheduled GitHub Action fires at once and queues.

---

## 16. Local development (fresh Windows machine)

**Prerequisites:** Node **≥ 20.9.0** — *"Minimum version now `20.9.0` (LTS); Node.js 18 no longer supported"* (`01-app/02-guides/upgrading/version-16.md:110`) — plus Docker Desktop and Git.

```bash
git clone <repo> && cd personalizer
npm install
npx playwright install chromium        # browser binary, separate from npm install
cp .env.example .env.local             # fill all eight
docker run -d --name pz-redis --restart unless-stopped -p 6379:6379 redis:7-alpine
npx supabase db push                   # apply migrations (DB.md §9)
npm run seed                           # demo campaign (DB.md §10)
```

Then, in two terminals:

```bash
npm run dev        # http://127.0.0.1:3000
npm run worker
```

### 16.1 Scripts

```json
{
  "dev": "next dev -H 127.0.0.1",
  "build": "next build",
  "start": "next start -H 127.0.0.1",
  "worker": "tsx --conditions react-server --env-file-if-exists=.env.local worker/index.ts",
  "seed": "tsx --env-file-if-exists=.env.local scripts/seed.ts",
  "typecheck": "tsc --noEmit",
  "test": "node --import tsx --test \"lib/**/*.test.ts\"",
  "verify:imports": "tsx scripts/verify-imports.ts",
  "verify:auth": "tsx --env-file-if-exists=.env.local scripts/verify-auth.ts",
  "verify:worker": "tsx --conditions react-server --env-file-if-exists=.env.local scripts/verify-worker.ts",
  "lint": "eslint"
}
```

**Two levels of verification, deliberately separate.** `npm test` is `node --test` over the pure logic — the login throttle's tiers, `env.ts`'s absent-vs-invalid reporting, the redirect sanitizer of §4.5, and session sign/verify. It needs no server, no database and no `.env.local`, so it runs on a fresh clone. `npm run verify:auth` asserts the wire contract of §4 against a **running** dev server and cannot be run without one.

`verify:auth` deliberately trips the throttle (it asserts that a correct password during a lockout still returns an identical `401`), which leaves the in-memory limiter poisoned for up to fifteen minutes. **Restart the dev server before a manual browser pass**, or the first real login will look broken. `node --test` is used rather than a framework because `tsx` is already a dependency — there is no runner to install.

**`--env-file-if-exists` is load-bearing.** Next.js loads `.env.local` automatically; `tsx` does not. Without the flag the worker starts with an empty environment and fails its own startup check, which looks like a configuration bug and is not one. The `-if-exists` variant (Node 22+) means a missing file is a warning rather than a crash, so CI and a fresh clone still run.

**`--conditions react-server` is required for `worker` and `verify:worker`.** `server-only` resolves to a throwing stub unless the `react-server` export condition is set. Both scripts import `lib/` modules that carry that marker (`lib/supabase.ts`, `lib/queue.ts`, …). Plain `npx tsx worker/index.ts` fails with *"This module cannot be imported from a Client Component module"*.

Optional worker tuning (bare `process.env` reads, not in `lib/env.ts`):

| Variable | Default | Purpose |
|---|---|---|
| `PIPELINE_RETRY_BASE_MS` | `30000` | Retry backoff base (→ 30s, 60s) |
| `PIPELINE_STUB_STEP_MS` | `500` | Artificial per-step delay in Phase 7 stubs |

> **Framework note — what changed and why.** `-H 127.0.0.1` is explicit and required. In Next.js 16 `--hostname` *"Default: 0.0.0.0"* (`01-app/03-api-reference/06-cli/next.md:71`), which exposes the dev server to the whole local network. This app holds every lead's contact details behind one shared password; on a café or coworking Wi-Fi, the default binding puts that on the network. Binding to loopback is the correct posture for a local-only admin tool.

### 16.2 `ffmpeg-static` needs its install script to run

`ffmpeg-static` **downloads** its ~79MB binary in a postinstall step; it is not in the npm tarball. Under npm's `allowScripts` policy (and in many CI sandboxes) that script is blocked, which leaves the module resolvable but pointing at a file that does not exist — so the failure surfaces much later, as `ffmpeg_failure` on the first merge, rather than at install time.

```bash
npm install-scripts approve ffmpeg-static      # then, if the binary is still absent:
node node_modules/ffmpeg-static/install.js
```

`ffprobe-static` is unaffected — it ships prebuilt binaries per platform.

**Playwright Chromium** is required for the Phase 8 recorder (`worker/recorder/`). It is not installed by `npm install` — run:

```bash
npm run setup:browser
# equivalent: npx playwright install chromium
```

Run `npm run verify:record` after installing Chromium to exercise the hermetic fixture leg. The network-dependent real-site leg is gated behind `RECORD_REAL=1`.

`npm run verify:page` is hermetic — no env file, no database. It generates a landing page from fixtures, serves it over two local HTTP origins (page + Supabase stand-in), and drives Chromium at 375px and 1920px with request interception. Run after `npm run setup:browser`.

**`--restart unless-stopped` on the Redis container is deliberate.** Without it, a reboot leaves Docker Desktop running but the container stopped, and the worker fails to connect with an error that points at Redis rather than at the missing container — a confusing five minutes every time the machine restarts. `unless-stopped` rather than `always` so that an explicit `docker stop pz-redis` still means stopped.

`npm run verify:imports` checks both binaries exist on disk, not merely that the modules import. Run it after any fresh `npm install`.

### 16.3 Two Windows notes

- **One dev server per project.** *"a lockfile mechanism prevents multiple `next dev` or `next build` instances on the same project"* (`version-16.md:922`). A second `npm run dev` fails rather than silently taking another port. Dev output now lives in `.next/dev` (`version-16.md:920`), so `next dev` and `next build` no longer clobber each other.
- **Paths.** `LOCAL_STORAGE_ROOT` is an absolute Windows path (`C:\personalizer-media`). All paths *stored in the database* are POSIX-relative to it (`DB.md` §3). Use `path.join` at every boundary; never concatenate. Long-path support matters — `{batch}/{lead-slug}/` with a long company name plus a collision hash approaches `MAX_PATH` on unprepared systems.

---

## 17. Risks and open items

| # | Risk | Mitigation / status |
|---|---|---|
| 1 | Anti-bot services block a meaningful share of leads | Classified as `blocked`, surfaced for manual handling. Accepted — we do not escalate. |
| 2 | Sequential processing is slow at 100 leads (~45–90 min) | Concurrency configurable to 3. Unattended runs make wall-clock secondary. |
| 3 | Netlify deploy serialization is a bottleneck | Only if deploys are frequent; each is small. Batch-deploy at the end of a run if it bites. |
| 4 | Recording quality varies with site design | Debug screenshots + per-step re-record. Some sites simply record poorly. |
| 5 | Local storage growth (~50–100MB/lead across artifacts) | 30-day raw purge, intermediates deleted. Masters accumulate — **needs a retention decision** once real volume exists. |
| 6 | Domain-only dedupe collisions | `DB.md` §6.1; accepted at this volume. |
| 7 | Redis as setup friction on Windows | §7.6 alternative stays viable; switch cost is bounded. |
| 8 | Netlify free-tier deploy limits at high lead counts | Unmeasured. **Open** — verify before the first 500-lead run. |

**Open questions for the next review**, deliberately not assumed:

1. **Master retention** (risk 5) — indefinite is stated but untested against real disk growth.
2. **`fullscreen_intro` layout** — §9.2 notes the master clock does not apply in that mode. The intended behavior when intro and recording lengths differ is undefined.
3. **Netlify rate limits** (risk 8).
4. ~~**No public poster frame**~~ — **resolved in Phase 10.** Merge uploads `poster.jpg` beside the video; page derives `{{poster_url}}` from `videos.poster_storage_key`. See `DB.md` §11 item 5.
5. **Merge with no recording at all** — **resolved in Phase 7.** Record-first-and-continue at most once per job; a second visit proceeds (see §11).
6. ~~**Dry-run terminal status**~~ — **resolved in Phase 11.** `campaign_leads.deployed_dry_run` plus a relaxed `campaign_leads_deployed_url_ck` allow `status='deployed'` with a null `netlify_url` when dry-run is active; a real deploy clears the flag. See `DB.md` §5.4.
7. **`retained_pages` manual removal** — no in-app UI. To stop serving a kept-after-delete page: delete the `retained_pages` row **and** trigger a `site-sync` (or wait for the next deploy of any kind — the manifest is desired state). Deleting the row alone unpublishes nothing until a sync runs.
8. **Mass-removal floor is a refusal, not a repair** (§10.3) — a manifest dropping >50 % of a 20+ page site fails the sync and keeps failing until the underlying data is fixed. That is deliberate (staying published beats mass-404), but there is no in-app surface saying *why*; the reason is only in the deployer log. Revisit when Phase 14 ships the Logs screen.
9. **End-to-end dry-run coverage** — `verify:deploy` proves manifest assembly makes zero HTTP calls, but the full assertion (a lead reaching `deployed_dry_run=true` with a null `netlify_url`) needs Supabase and currently rides on the production run. A `verify:worker`-style leg would close it.

---

## 18. Framework claims index

Every Next.js assertion in this document, for re-verification. Paths relative to `node_modules/next/dist/docs/`.

| Claim | Path:line | Used in |
|---|---|---|
| `middleware` renamed to `proxy` | `01-app/03-api-reference/03-file-conventions/proxy.md:11` | §4.1 |
| Server Function POSTs skip excluded matcher paths | `01-app/03-api-reference/03-file-conventions/proxy.md:217,219` | §4.2 |
| Server Functions reachable by direct POST | `01-app/01-getting-started/07-mutating-data.md:32` | §4.2 |
| Verify auth inside each action, not in Proxy alone | `01-app/02-guides/production-checklist.md:102` | §4.2 |
| Render-time gating is not a security boundary | `01-app/02-guides/server-actions.md:89` | §4.2 |
| Server Action body limit 1MB | `01-app/02-guides/server-actions.md:83` | §4.3 |
| `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` for self-hosted | `01-app/02-guides/server-actions.md:85` | §14.1 |
| Route Handlers not cached by default | `01-app/01-getting-started/15-route-handlers.md:51` | §4.3 |
| Sync request APIs fully removed | `01-app/02-guides/upgrading/version-16.md:298` | §4.4 |
| Custom webpack config fails the build | `01-app/02-guides/upgrading/version-16.md:142,146,160` | §14.3 |
| Node 20.9+ required | `01-app/02-guides/upgrading/version-16.md:110` | §16 |
| `next dev` hostname defaults to 0.0.0.0 | `01-app/03-api-reference/06-cli/next.md:71` | §16.1 |
| `.next/dev` output + instance lockfile | `01-app/02-guides/upgrading/version-16.md:920,922` | §16.2 |
| `register()` blocks server readiness | `01-app/03-api-reference/03-file-conventions/instrumentation.md:18` | §2 |
