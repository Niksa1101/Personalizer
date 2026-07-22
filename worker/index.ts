/**
 * Worker process entry point.
 *
 * Runs as a genuinely separate process from the Next.js server — started with
 * `npm run worker`, alongside `npm run dev`. See docs/Tech.md §2 for why this is
 * not launched from `instrumentation.ts`.
 *
 * PHASE 0: this is the entry point and the startup environment check only.
 * The BullMQ topology, the four pipeline steps, retry/backoff and boot recovery
 * all land in Phase 7 (docs/PRD.md §11).
 */

import { assertEnvOrExit } from '../lib/env-node'

const env = assertEnvOrExit()

console.log('[worker] environment OK — all 8 variables present')
console.log(`[worker] storage root: ${env.LOCAL_STORAGE_ROOT}`)
console.log(`[worker] redis:        ${env.REDIS_URL}`)
console.log('[worker] pipeline not implemented yet — see docs/PRD.md §11 Phase 7')
