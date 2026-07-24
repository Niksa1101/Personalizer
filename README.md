# Personalizer

Turn a Lead Finder CSV into personalized videos and public landing pages — one operator, one machine, loopback-only.

## Getting started

1. Copy `.env.example` to `.env.local` and fill all eight variables (see `docs/Tech.md` §14.1).
2. Install dependencies: `npm install`
3. Start the dev server: `npm run dev` — binds to **http://127.0.0.1:3000** (not `0.0.0.0`).
4. Install Playwright Chromium for website recording: `npm run setup:browser`
5. Open http://127.0.0.1:3000 and sign in with `APP_PASSWORD`.

## Authentication / first login

Personalizer protects every lead's PII behind a **single shared password** (`APP_PASSWORD` in `.env.local`). There are no user accounts — one session cookie (`pz_session`) means "logged in."

| Variable | Purpose |
|---|---|
| `APP_PASSWORD` | The password you type on `/login`. Compared with a timing-safe SHA-256 digest check. |
| `SESSION_SECRET` | HS256 signing key for the session cookie. Must be **at least 32 characters**. |

Generate a strong `SESSION_SECRET`:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

**Session behaviour:**

- **7-day absolute expiry** from login — no sliding refresh. After seven days, sign in again.
- **Rotating `SESSION_SECRET` invalidates every session** — all users (there is only one) must log in again. This is accepted; there is no migration path.
- **Repeated wrong passwords are silently throttled** on the server — 5 failures in 60s, or 10 in 15 minutes. The throttle is in-memory and **global, not per IP**: nothing sits in front of this app, so `X-Forwarded-For` would be caller-supplied and a per-IP key would be trivially bypassable.
- **A lockout is indistinguishable from a wrong password.** The server returns the same `401` either way — no `429`, no `Retry-After`, no countdown in the UI. If a password you are sure of keeps failing, you are probably throttled; wait a minute.
- **Restarting the dev server clears the throttle** — a deliberate escape hatch during development.

Run the tests (no server, no database, no `.env.local` needed):

```bash
npm test
```

Verify auth end-to-end against the wire contract (dev server must already be running):

```bash
npm run verify:auth
```

`verify:auth` deliberately trips the throttle, so **restart the dev server afterwards** before signing in through the browser — otherwise the first real login looks broken.

## App shell / navigation & theming

After sign-in, every screen is reachable from the sidebar, grouped **Work** (Dashboard, Leads, Queue), **Setup** (Campaigns, Intro Videos, Import), and **System** (Logs, Settings). Each screen shows a purpose-specific empty state until its phase lands.

- **Theme:** light / dark / system via the toggle in the sidebar footer. Preference persists across reloads (`next-themes`).
- **Sign out:** sidebar footer, next to the theme toggle.
- **Verify the shell** (dev server must already be running):

```bash
npm run verify:shell
npm run verify:server-only
```

`verify:shell` GETs all eight routes plus a sample campaign detail URL and asserts 200 with no error boundary. `verify:server-only` proves a client import of `lib/supabase.ts` fails the build.

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Next.js app on 127.0.0.1:3000 |
| `npm run build` | Production build |
| `npm run typecheck` | TypeScript check |
| `npm test` | Unit tests (`node --test`) — throttle, env validation, redirect sanitation, sessions |
| `npm run verify:auth` | Auth assertions against a live dev server |
| `npm run verify:shell` | Shell route reachability against a live dev server |
| `npm run verify:server-only` | Negative build test — client import of Supabase client must fail |
| `npm run verify:imports` | Dependency and binary smoke test |
| `npm run verify:worker` | Worker and queue verification (Phase 7) |
| `npm run verify:record` | Recorder fixture verification (Phase 8) |
| `npm run setup:browser` | Install Playwright Chromium for website recording |
| `npm run seed` | Seed demo data (requires Supabase) |
| `npm run worker` | Background job worker |

## Documentation

- `docs/PRD.md` — product scope and build phases
- `docs/Tech.md` — architecture, auth, pipeline, env
- `docs/DB.md` — schema and migrations
