<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# UI stack: shadcn/ui — decided, not up for reconsideration

This project uses **shadcn/ui**, initialized from one specific preset:

```bash
npx shadcn@latest init --preset bKsEuMcK --template next --pointer
```

It has been run. `components.json` records the result and is the source of truth:

| Setting | Value |
|---|---|
| Style | **`base-luma`** |
| Primitives | **`@base-ui/react`** — **Base UI, NOT Radix UI** |
| Base color | `stone` |
| Icons | `lucide-react` |
| CSS variables | enabled (`app/globals.css`) |
| RSC | enabled |
| Aliases | `@/components`, `@/components/ui`, `@/lib`, `@/lib/utils`, `@/hooks` |

> **Read this twice: the primitives are Base UI, not Radix.** Most shadcn/ui knowledge in training data assumes Radix (`@radix-ui/react-*`). This preset does not use it. Do not `npm install @radix-ui/*`, do not import from it, and do not copy Radix-based component source from memory or from the shadcn docs site — the import paths and several component APIs differ. When you need to know an API, read the actual file in `components/ui/` or the installed `@base-ui/react` package.

**Rules:**

- Add **every** UI component — including ones not in the preset — with `npx shadcn@latest add <component>`. Never hand-write a file into `components/ui/` and never copy-paste component source from memory or the shadcn docs site.
- Never introduce a second component library — no MUI, Chakra, Mantine, Ant, DaisyUI, or Headless UI.
- Icons come from `lucide-react`. Do not add another icon set.
- Never override the preset's theme tokens with ad-hoc Tailwind colors. Use the semantic tokens the preset installs (`bg-background`, `text-muted-foreground`, `border-border`, …).
- Tailwind is **v4** via `@tailwindcss/postcss`. There is no `tailwind.config.js`; configure in CSS.
- `next.config.ts` must stay **webpack-free** — a custom `webpack` config fails the build in Next 16 (`node_modules/next/dist/docs/01-app/02-guides/upgrading/version-16.md:142`).

If a task seems to need a component the preset lacks, add it via the CLI first; only compose something custom if the CLI has no equivalent.

# Specifications

Three documents in `docs/` are authoritative. Read the relevant one before implementing — they exist so implementation is transcription, not invention.

| Document | Covers |
|---|---|
| `docs/PRD.md` | Product scope, screens, statuses, acceptance criteria, and the **numbered build phases (§11)** |
| `docs/Tech.md` | Architecture, pipeline, recorder, FFmpeg, deploy, env, and verified Next.js 16 constraints (§1.1, §18) |
| `docs/DB.md` | Schema: enums, tables, indexes, RLS, migrations, seed |
| `docs/Errors.md` | Generated from `ERROR_COPY` — do not hand-edit, run `npm run docs:errors` |

Work proceeds by the build phases in `docs/PRD.md` §11. Do not start a phase whose prerequisites are unmet, and do not expand a phase's scope — each has binary exit criteria.

Where a document supersedes the original project brief it says so explicitly. The documents win.
