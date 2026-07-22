/**
 * Database seed.
 *
 * Spec: docs/DB.md §10, docs/PRD.md §11 Phase 1.
 *
 * The seed is a single idempotent SQL function, public.seed_demo_data(),
 * shipped by migration 20260720120900_seed_function.sql. This script validates
 * the environment and calls it. supabase/seed.sql calls the same function, so
 * `npm run seed` and `supabase db reset` cannot produce different databases.
 *
 * Idempotent: running it twice changes nothing. The second run reports zeroes
 * rather than claiming success blindly (Phase 1 exit criteria).
 *
 * Deliberately does NOT import lib/supabase.ts — that module carries
 * `server-only` (docs/Tech.md §3), which throws when resolved outside a
 * bundler. A plain tsx script builds its own client.
 */

import { createClient } from '@supabase/supabase-js'
import { assertEnvOrExit } from '../lib/env-node'

/** Shape returned by public.seed_demo_data(). */
interface SeedReport {
  settings_inserted: number
  campaign_created: boolean
  campaign_id: string
  leads_inserted: number
  campaign_leads_inserted: number
  events_inserted: number
}

async function main(): Promise<void> {
  const env = assertEnvOrExit()

  const supabase = createClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } },
  )

  const { data, error } = await supabase.rpc('seed_demo_data')

  if (error) {
    // The overwhelmingly likely cause is migrations not having been applied, so
    // say that rather than leaving the operator with a bare PostgREST code.
    console.error('\n  [seed] failed: ' + error.message)
    if (error.hint) console.error('  [seed] hint: ' + error.hint)
    console.error(
      '\n  If this reads as a missing function, the migrations have not been\n' +
        '  applied yet. Run `npx supabase db push` first (docs/DB.md §9).\n',
    )
    process.exit(1)
  }

  const report = data as SeedReport

  console.log('[seed] done.')
  console.log(`  settings keys added   : ${report.settings_inserted}`)
  console.log(`  demo campaign         : ${report.campaign_created ? 'created' : 'already present'}`)
  console.log(`  leads added           : ${report.leads_inserted}`)
  console.log(`  campaign leads added  : ${report.campaign_leads_inserted}`)
  console.log(`  timeline events added : ${report.events_inserted}`)

  const changed =
    report.settings_inserted +
    report.leads_inserted +
    report.campaign_leads_inserted +
    report.events_inserted

  if (changed === 0 && !report.campaign_created) {
    console.log('[seed] nothing changed — the database was already seeded.')
  } else {
    console.log(
      '[seed] the demo campaign has no intro video, so its leads sit at\n' +
        '       Paused – Needs Intro. Assign an intro to resume them (PRD.md AC-4).',
    )
  }
}

main().catch((err: unknown) => {
  console.error('[seed] unexpected failure:', err)
  process.exit(1)
})
