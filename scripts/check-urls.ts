/**
 * Production URL checker — asserts HTTP status and, for 200 responses, noindex.
 * Args: URL EXPECTED_STATUS[:EXPECTED_BODY_SUBSTRING] [...]
 *
 * Redirects are NOT followed: a page that 301s elsewhere is not the page under
 * test, and following would let it pass the 200 + noindex check.
 *
 * The optional body substring is what distinguishes "200 served from
 * retained_pages" from "200 because the delete never happened" — pass something
 * unique to the retained snapshot (a lead name, the CTA URL).
 *
 * Example (Phase 11 exit: 8×200, 1×404, 1×200 retained):
 *   npm run check:urls -- \
 *     https://site.netlify.app/campaign/lead-3 200 \
 *     https://site.netlify.app/campaign/lead-4 200 \
 *     ... \
 *     https://site.netlify.app/campaign/lead-1 404 \
 *     https://site.netlify.app/campaign/lead-2 200:Acme%20Dental
 */

interface CheckResult {
  name: string
  ok: boolean
  detail: string
}

const REQUEST_TIMEOUT_MS = 30_000
const NOINDEX_PATTERN = /<meta[^>]+name=["']robots["'][^>]+content=["'][^"']*noindex/i

const results: CheckResult[] = []

function pass(name: string, detail = "ok"): void {
  results.push({ name, ok: true, detail })
  console.log(`PASS  ${name}${detail === "ok" ? "" : ` — ${detail}`}`)
}

function fail(name: string, detail: string): void {
  results.push({ name, ok: false, detail })
  console.error(`FAIL  ${name} — ${detail}`)
}

type UrlCheck = { url: string; expected: number; bodyContains?: string }

function usage(): never {
  console.error(
    `Usage: npm run check:urls -- <url> <status>[:<body-substring>] [...]`,
  )
  console.error("  status:        HTTP status code (e.g. 200, 404)")
  console.error(
    "  body-substring: optional, percent-encoded; asserted against the response body",
  )
  process.exit(2)
}

function parsePairs(argv: string[]): UrlCheck[] {
  if (argv.length === 0 || argv.length % 2 !== 0) {
    usage()
  }

  const pairs: UrlCheck[] = []
  for (let i = 0; i < argv.length; i += 2) {
    const url = argv[i]!
    const spec = argv[i + 1]!
    const separator = spec.indexOf(":")
    const statusPart = separator === -1 ? spec : spec.slice(0, separator)
    const bodyPart = separator === -1 ? "" : spec.slice(separator + 1)

    const expected = Number.parseInt(statusPart, 10)
    if (!Number.isFinite(expected) || expected < 100 || expected > 599) {
      console.error(`Invalid status for ${url}: ${spec}`)
      process.exit(2)
    }
    if (!URL.canParse(url)) {
      console.error(`Invalid URL: ${url}`)
      process.exit(2)
    }

    pairs.push({
      url,
      expected,
      bodyContains: bodyPart ? decodeURIComponent(bodyPart) : undefined,
    })
  }
  return pairs
}

async function fetchStatus(
  url: string,
): Promise<{ status: number; body: string; location: string | null }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      // Not "follow": a redirect means this URL is not serving the page under
      // test, and following it would let an unrelated 200 pass the check.
      redirect: "manual",
      signal: controller.signal,
      headers: { Accept: "text/html,*/*" },
    })
    const body = await response.text()
    return {
      status: response.status,
      body,
      location: response.headers.get("location"),
    }
  } finally {
    clearTimeout(timer)
  }
}

async function checkPair(check: UrlCheck): Promise<void> {
  const { url, expected } = check
  const label = `${url} → ${expected}`

  let status: number
  let body: string
  let location: string | null
  try {
    ;({ status, body, location } = await fetchStatus(url))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    fail(label, `request failed: ${message}`)
    return
  }

  if (status !== expected) {
    fail(
      label,
      location
        ? `got HTTP ${status} → ${location}`
        : `got HTTP ${status}`,
    )
    return
  }

  if (expected === 200 && !NOINDEX_PATTERN.test(body)) {
    fail(label, "200 but missing noindex robots meta")
    return
  }

  if (check.bodyContains && !body.includes(check.bodyContains)) {
    fail(label, `body is missing ${JSON.stringify(check.bodyContains)}`)
    return
  }

  pass(
    label,
    check.bodyContains ? `HTTP ${status}, body matched` : `HTTP ${status}`,
  )
}

async function main(): Promise<void> {
  const pairs = parsePairs(process.argv.slice(2))
  console.log(`check-urls — ${pairs.length} URL(s)\n`)

  for (const check of pairs) {
    await checkPair(check)
  }

  const failed = results.filter((r) => !r.ok).length
  const passed = results.length - failed
  console.log(`\n${passed}/${results.length} checks passed`)
  // exitCode rather than exit(): this output gets pasted into the PRD as
  // evidence, and tearing down mid-flight makes libuv abort on Windows.
  process.exitCode = failed > 0 ? 1 : 0
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

export {}
