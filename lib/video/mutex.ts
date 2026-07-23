/** Serialize FFmpeg transcodes — one at a time per Next process (D9). */
let chain: Promise<unknown> = Promise.resolve()

export function withTranscodeLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn)
  chain = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}
