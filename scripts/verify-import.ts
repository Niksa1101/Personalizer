/**
 * CSV import verification against a running dev server (Phase 6).
 * Does not start the server — fails loudly if nothing is listening.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { createClient } from "@supabase/supabase-js"

import type { Database } from "../lib/database.types"
import { assertEnvOrExit } from "../lib/env-node"
import type { PreviewResult } from "../lib/import-types"
import { SLUG_REGEX } from "../lib/slug"

const BASE_URL = "http://127.0.0.1:3000"

interface CheckResult {
  name: string
  ok: boolean
  detail: string
}

const results: CheckResult[] = []

function pass(name: string, detail = "ok"): void {
  results.push({ name, ok: true, detail })
  console.log(`PASS  ${name}${detail === "ok" ? "" : ` — ${detail}`}`)
}

function fail(name: string, detail: string): void {
  results.push({ name, ok: false, detail })
  console.error(`FAIL  ${name} — ${detail}`)
}

function reconcile(counts: PreviewResult["counts"], rowCount: number): boolean {
  const total =
    counts.imported +
    counts.linked +
    counts.duplicate +
    counts.skipped +
    counts.rejected
  return total === rowCount
}

async function probeServer(): Promise<boolean> {
  try {
    const response = await fetch(`${BASE_URL}/login`, {
      redirect: "manual",
      signal: AbortSignal.timeout(3000),
    })
    return response.status >= 200 && response.status < 500
  } catch {
    return false
  }
}

function getSetCookie(response: Response): string | null {
  const headers = response.headers as Headers & {
    getSetCookie?: () => string[]
  }
  if (typeof headers.getSetCookie === "function") {
    const values = headers.getSetCookie()
    return values.length > 0 ? values.join(", ") : null
  }
  return response.headers.get("set-cookie")
}

function parseCookies(setCookie: string | null): Map<string, string> {
  const jar = new Map<string, string>()
  if (!setCookie) return jar

  for (const part of setCookie.split(/,(?=\s*[^;]+=)/)) {
    const [pair] = part.split(";")
    const eq = pair?.indexOf("=")
    if (eq === undefined || eq <= 0) continue
    const name = pair.slice(0, eq).trim()
    const value = pair.slice(eq + 1).trim()
    jar.set(name, value)
  }

  return jar
}

async function login(): Promise<string | null> {
  const password = process.env.APP_PASSWORD?.trim()
  if (!password) {
    console.error("APP_PASSWORD is not set. Load .env.local or export it before running.")
    process.exit(1)
  }

  const response = await fetch(`${BASE_URL}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  })

  const jar = parseCookies(getSetCookie(response))
  return jar.get("pz_session") ?? null
}

function buildCsv(rows: Array<[string, string, string]>): string {
  const header = "company,website,email"
  const lines = rows.map(
    ([company, website, email]) => `${company},${website},${email}`,
  )
  return [header, ...lines].join("\n")
}

async function main(): Promise<void> {
  if (!(await probeServer())) {
    console.error(
      `Personalizer dev server is not reachable at ${BASE_URL}.\n` +
        "Start it with `npm run dev` in another terminal, then rerun `npm run verify:import`.",
    )
    process.exit(1)
  }

  const sessionCookie = await login()
  if (!sessionCookie) {
    fail("Session login", "could not obtain pz_session cookie")
    process.exit(1)
  }
  pass("Session login")

  const cookieHeader = `pz_session=${sessionCookie}`
  const env = assertEnvOrExit()
  const supabase = createClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } },
  )

  const runId = Date.now().toString(36)
  const tempDir = mkdtempSync(path.join(tmpdir(), "verify-import-"))

  const batchIds: string[] = []
  let leadDomains: string[] = []

  try {
    const { data: campaigns, error: campaignsError } = await supabase
      .from("campaigns")
      .select("id, name")
      .is("archived_at", null)
      .order("created_at", { ascending: true })
      .limit(2)

    if (campaignsError || (campaigns?.length ?? 0) < 2) {
      fail("seed campaigns", campaignsError?.message ?? "need at least two active campaigns")
      process.exit(1)
    }

    const [campaignA, campaignB] = campaigns!
    pass("seed campaigns", `${campaignA.name}, ${campaignB.name}`)

    leadDomains = Array.from({ length: 100 }, (_, i) => `verify-${runId}-${i}.example.com`)
    const rows: Array<[string, string, string]> = leadDomains.map((domain, i) => [
      `Verify Co ${i}`,
      `https://${domain}`,
      "",
    ])

    const csv100 = buildCsv(rows)
    const csv100Path = path.join(tempDir, "leads-100.csv")
    writeFileSync(csv100Path, csv100, "utf8")

    async function uploadPreview(
      campaignId: string,
      filePath: string,
      filename: string,
    ): Promise<PreviewResult & { error?: string }> {
      const { readFileSync } = await import("node:fs")
      const form = new FormData()
      form.append("campaignId", campaignId)
      form.append(
        "file",
        new Blob([readFileSync(filePath)], { type: "text/csv" }),
        filename,
      )

      const response = await fetch(`${BASE_URL}/api/import`, {
        method: "POST",
        headers: { Cookie: cookieHeader },
        body: form,
      })

      return (await response.json()) as PreviewResult & { error?: string }
    }

    async function commitImport(
      preview: PreviewResult,
      campaignId: string,
      filename: string,
    ): Promise<{ batchId?: string; error?: string }> {
      const response = await fetch(`${BASE_URL}/api/import`, {
        method: "POST",
        headers: {
          Cookie: cookieHeader,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          token: preview.token,
          campaignId,
          filename,
          mapping: preview.mapping,
        }),
      })

      return (await response.json()) as { batchId?: string; error?: string }
    }

    const preview100 = await uploadPreview(campaignA.id, csv100Path, "leads-100.csv")
    if (!preview100.token) {
      fail("preview 100-row CSV", preview100.error ?? "missing token")
      process.exit(1)
    }
    pass("preview 100-row CSV", `${preview100.rowCount} rows`)

    if (!reconcile(preview100.counts, preview100.rowCount)) {
      fail(
        "counts reconcile (preview)",
        `${preview100.counts.imported}+${preview100.counts.linked}+${preview100.counts.duplicate}+${preview100.counts.skipped}+${preview100.counts.rejected} !== ${preview100.rowCount}`,
      )
    } else {
      pass("counts reconcile (preview)")
    }

    if (preview100.counts.imported !== 100) {
      fail("100 new imports (preview)", `imported=${preview100.counts.imported}`)
    } else {
      pass("100 new imports (preview)")
    }

    const commit100 = await commitImport(preview100, campaignA.id, "leads-100.csv")
    if (!commit100.batchId) {
      fail("commit 100-row CSV", commit100.error ?? "missing batchId")
      process.exit(1)
    }
    batchIds.push(commit100.batchId)
    pass("commit 100-row CSV", commit100.batchId)

    const { data: batchRow } = await supabase
      .from("import_batches")
      .select("*")
      .eq("id", commit100.batchId)
      .single()

    if (!batchRow) {
      fail("batch persisted", "missing row")
    } else if (batchRow.imported_count !== 100) {
      fail("batch imported_count", String(batchRow.imported_count))
    } else {
      pass("batch imported_count", "100")
    }

    const dupPreview = await uploadPreview(campaignA.id, csv100Path, "leads-100.csv")
    if (!dupPreview.token) {
      fail("re-import preview", dupPreview.error ?? "missing token")
    } else if (dupPreview.counts.duplicate !== 100) {
      fail("re-import duplicates", `duplicate=${dupPreview.counts.duplicate}`)
    } else if (dupPreview.counts.imported !== 0) {
      fail("re-import zero new", `imported=${dupPreview.counts.imported}`)
    } else {
      pass("re-import same campaign", "100 duplicates, 0 new")
    }

    const linkPreview = await uploadPreview(campaignB.id, csv100Path, "leads-100.csv")
    if (!linkPreview.token) {
      fail("cross-campaign preview", linkPreview.error ?? "missing token")
    } else if (linkPreview.counts.linked !== 100) {
      fail("cross-campaign links", `linked=${linkPreview.counts.linked}`)
    } else if (linkPreview.counts.imported !== 0) {
      fail("cross-campaign zero new leads", `imported=${linkPreview.counts.imported}`)
    } else {
      pass("cross-campaign import", "100 links, 0 new leads")
    }

    const linkCommit = await commitImport(linkPreview, campaignB.id, "leads-100.csv")
    if (!linkCommit.batchId) {
      fail("cross-campaign commit", linkCommit.error ?? "missing batchId")
    } else {
      batchIds.push(linkCommit.batchId)
      pass("cross-campaign commit")
    }

    const raggedCsv = [
      "company,website,email",
      "Ragged Co,https://ragged.example.com",
      "Good Co,https://good.example.com,good@example.com",
    ].join("\n")
    const raggedPath = path.join(tempDir, "ragged.csv")
    writeFileSync(raggedPath, raggedCsv, "utf8")

    const raggedPreview = await uploadPreview(campaignA.id, raggedPath, "ragged.csv")
    if (!raggedPreview.token) {
      fail("ragged preview", raggedPreview.error ?? "missing token")
    } else {
      const rejected = raggedPreview.rejectedRows.find((row) => row.row === 2)
      if (!rejected) {
        fail("ragged row line number", "line 2 not rejected")
      } else if (!rejected.reason.includes("ragged row")) {
        fail("ragged row reason", rejected.reason)
      } else {
        pass("ragged row rejection", "line 2")
      }
    }

    const slugDomains = [
      `slug-a-${runId}.example.com`,
      `slug-b-${runId}.example.com`,
    ]
    const slugCsv = [
      "company,city,website",
      `Acme Plumbing,Portland,https://${slugDomains[0]}`,
      `Acme Plumbing,Portland,https://${slugDomains[1]}`,
    ].join("\n")
    const slugPath = path.join(tempDir, "slug-collision.csv")
    writeFileSync(slugPath, slugCsv, "utf8")

    const slugPreview = await uploadPreview(campaignA.id, slugPath, "slug-collision.csv")
    if (!slugPreview.token) {
      fail("slug collision preview", slugPreview.error ?? "missing token")
    } else if (slugPreview.counts.imported !== 2) {
      fail("slug collision imports", `imported=${slugPreview.counts.imported}`)
    } else {
      pass("slug collision preview", "2 new rows")
    }

    const slugCommit = await commitImport(slugPreview, campaignA.id, "slug-collision.csv")
    if (!slugCommit.batchId) {
      fail("slug collision commit", slugCommit.error ?? "missing batchId")
    } else {
      batchIds.push(slugCommit.batchId)
      pass("slug collision commit")
    }

    const { data: slugRows, error: slugRowsError } = await supabase
      .from("campaign_leads")
      .select("slug, leads!inner(domain)")
      .eq("campaign_id", campaignA.id)
      .in("leads.domain", slugDomains)

    if (slugRowsError || (slugRows?.length ?? 0) !== 2) {
      fail(
        "slug collision rows",
        slugRowsError?.message ?? `expected 2 rows, got ${slugRows?.length ?? 0}`,
      )
    } else {
      const slugs = slugRows!.map((row) => row.slug)
      const bare = "acme-plumbing-portland"
      const bareCount = slugs.filter((slug) => slug === bare).length
      const hashed = slugs.filter((slug) => slug !== bare)

      if (bareCount !== 1) {
        fail(
          "slug collision bare slug",
          `expected exactly one ${bare}, got ${bareCount}: ${slugs.join(", ")}`,
        )
      } else if (
        hashed.length !== 1 ||
        !/^acme-plumbing-portland-[0-9a-f]{6}$/.test(hashed[0] ?? "")
      ) {
        fail(
          "slug collision hashed slug",
          `expected one hashed slug, got ${hashed.join(", ")}`,
        )
      } else if (!slugs.every((slug) => SLUG_REGEX.test(slug))) {
        fail("slug regex", slugs.join(", "))
      } else {
        pass("identical name+city slugs differ", slugs.join(" vs "))
      }
    }

    leadDomains = [...leadDomains, ...slugDomains]
  } catch (error) {
    fail(
      "verify:import",
      error instanceof Error ? error.message : String(error),
    )
  } finally {
    if (leadDomains.length > 0) {
      await supabase.from("leads").delete().in("domain", leadDomains)
    }

    for (const batchId of batchIds) {
      await supabase.from("import_batches").delete().eq("id", batchId)
    }

    rmSync(tempDir, { recursive: true, force: true })
  }

  const failed = results.filter((result) => !result.ok)
  const passed = results.filter((result) => result.ok)

  console.log("")
  console.log(`Summary: ${passed.length} passed, ${failed.length} failed`)

  if (failed.length > 0) {
    process.exit(1)
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
