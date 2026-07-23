/**
 * CSRF origin comparison for state-changing routes (Tech.md §4.2, D44).
 *
 * Loopback aliases (localhost, 127.0.0.1, ::1) normalize to the same key so
 * signing in at http://localhost:3000 still works when the server bound to
 * 127.0.0.1 reports that host in request.url.
 */

function normalizeOrigin(origin: string): string {
  try {
    const url = new URL(origin)
    const isLoopback =
      url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "[::1]" ||
      url.hostname === "::1"

    if (isLoopback) {
      const port = url.port || (url.protocol === "https:" ? "443" : "80")
      return `${url.protocol}//127.0.0.1:${port}`
    }

    return url.origin
  } catch {
    return origin
  }
}

export function originsMatch(origin: string, requestOrigin: string): boolean {
  return normalizeOrigin(origin) === normalizeOrigin(requestOrigin)
}
