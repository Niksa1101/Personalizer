/**
 * Post-login redirect target sanitation.
 *
 * Shared because there are two independent sources of a `next` value and they
 * must agree:
 *
 *   • `/login?next=…`         — set by proxy.ts for a browser with no cookie
 *   • the `x-pathname` header — set by proxy.ts for a browser whose cookie is
 *     present but invalid, which only app/(app)/layout.tsx can detect
 *
 * Both are attacker-influenceable (a query string always; a header because the
 * proxy copies it from the request URL), so both go through this function. Any
 * value that could leave the origin falls back to `/`.
 */

/** True for a value that is safe to hand to `redirect()` or `router.push()`. */
function isSafeInternalPath(raw: string): boolean {
  // Must be origin-relative...
  if (!raw.startsWith('/')) return false
  // ...and not protocol-relative. `//evil.com` and `/\evil.com` are both read
  // as absolute by browsers — the second because they normalize `\` to `/`.
  if (raw.startsWith('//') || raw.startsWith('/\\')) return false
  // A control character can smuggle a line break into a Location header.
  // Checked by code point rather than a regex literal so that no raw control
  // characters have to live in this source file.
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f) return false
  }
  return true
}

export function safeNext(raw: string | string[] | null | undefined): string {
  if (typeof raw !== 'string') return '/'
  return isSafeInternalPath(raw) ? raw : '/'
}

/** `/login`, carrying `next` only when it points somewhere worth returning to. */
export function loginUrlFor(raw: string | string[] | null | undefined): string {
  const next = safeNext(raw)
  return next === '/' ? '/login' : `/login?next=${encodeURIComponent(next)}`
}
