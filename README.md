# Personalizer

Turn a Lead Finder CSV into personalized videos and public landing pages — one operator, one machine, loopback-only.

## Getting started

1. Copy `.env.example` to `.env.local` and fill all eight variables (see `docs/Tech.md` §14.1).
2. Install dependencies: `npm install`
3. Start the dev server: `npm run dev` — binds to **http://127.0.0.1:3000** (not `0.0.0.0`).
4. Open http://127.0.0.1:3000 and sign in with `APP_PASSWORD`.

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
- **Repeated wrong passwords are silently throttled** on the server (in-memory, per IP). The UI always shows "Incorrect password"; there is no `429` or lockout message from the server.
- **Restarting the dev server clears the throttle** — a deliberate escape hatch during development.

Verify auth end-to-end (dev server must already be running):

```bash
npm run verify:auth
```

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Next.js app on 127.0.0.1:3000 |
| `npm run build` | Production build |
| `npm run typecheck` | TypeScript check |
| `npm run verify:auth` | Auth assertions against a live dev server |
| `npm run verify:imports` | Dependency and binary smoke test |
| `npm run seed` | Seed demo data (requires Supabase) |
| `npm run worker` | Background job worker |

## Documentation

- `docs/PRD.md` — product scope and build phases
- `docs/Tech.md` — architecture, auth, pipeline, env
- `docs/DB.md` — schema and migrations
