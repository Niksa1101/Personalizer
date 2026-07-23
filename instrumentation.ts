/**
 * Next.js instrumentation hook.
 *
 * `register()` is called once per server instance and must complete before the
 * server is ready to handle requests
 * (node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/instrumentation.md:18).
 *
 * That makes it the right place for the startup environment check and the wrong
 * place for anything long-lived. The BullMQ worker is deliberately NOT started
 * here — see docs/Tech.md §2. It runs as a separate process (`npm run worker`).
 */

export async function register() {
  // `next build` imports this module while collecting page data. Validating
  // there would make a build impossible without a configured .env.local, which
  // would break CI and a fresh clone. The check belongs to *booting*, not
  // compiling.
  if (process.env.NEXT_PHASE === 'phase-production-build') return

  // Throws EnvValidationError, whose message names every missing variable.
  // Throwing (rather than exiting) keeps this module Edge-compatible and still
  // refuses the boot — `register()` must complete before the server is ready.
  const { assertEnv } = await import('./lib/env')
  assertEnv()

  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { storageAbs } = await import('./lib/storage')
    const { sweepStaleIntroUploadTemps } = await import('./lib/local-file')
    await sweepStaleIntroUploadTemps(storageAbs('tmp'))
  }
}
