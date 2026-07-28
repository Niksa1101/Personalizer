/** Server/worker env readers — keep out of pipeline-types (client-safe enum mirror). */

export function readRetryBaseMs(): number {
  const raw = process.env.PIPELINE_RETRY_BASE_MS
  if (raw === undefined || raw === "") return 30_000
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30_000
}

export function readStubStepMs(): number {
  const raw = process.env.PIPELINE_STUB_STEP_MS
  if (raw === undefined || raw === "") return 500
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 500
}
