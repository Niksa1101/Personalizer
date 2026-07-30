/**
 * Schema invariants that no feature-level verify script owns.
 *
 * Currently the human-ref generators (`DB.md` §4.2). Phase 1 verified both
 * sequences and still shipped a truncation cliff, because the check only ever
 * exercised values *below* the padding boundary — `lpad()` truncates on the
 * right, so `lpad('118', 2, '0')` is `'11'` and every value in a decade
 * collapsed onto the same ref once the sequence passed 99.
 *
 * Coverage, stated honestly: `campaign_ref_seq` is already past its 2-digit
 * boundary, so the campaign legs exercise the formerly-broken path directly on
 * every run. `lead_ref_seq` is in the hundreds and its boundary is 10 000, which
 * cannot be reached without burning ~9 000 values — so the lead legs prove the
 * generator is well-formed and single-`nextval` at its current position, and the
 * boundary itself rests on both generators sharing one `greatest()` formula.
 *
 * Cost: each run consumes SAMPLE_SIZE values from each ref sequence. Sequences
 * are counters, not inventory — refs are already sparse because every verify
 * script creates and deletes fixtures — but it is why these legs assert on
 * *relative* movement rather than on any absolute value.
 */

import { createClient } from "@supabase/supabase-js"

import type { Database } from "../lib/database.types"
import { assertEnvOrExit } from "../lib/env-node"

interface CheckResult {
  name: string
  state: "pass" | "fail" | "skip"
  detail: string
}

const results: CheckResult[] = []

function pass(name: string, detail = "ok"): void {
  results.push({ name, state: "pass", detail })
  console.log(`PASS  ${name}${detail === "ok" ? "" : ` — ${detail}`}`)
}

function fail(name: string, detail: string): void {
  results.push({ name, state: "fail", detail })
  console.error(`FAIL  ${name} — ${detail}`)
}

function skip(name: string, reason: string): void {
  results.push({ name, state: "skip", detail: reason })
  console.log(`SKIP  ${name} — ${reason}`)
}

type RefSpec = {
  label: string
  fn: "next_campaign_ref" | "next_lead_ref"
  prefix: string
  /** Historical zero-pad floor: the width refs had before any value outgrew it. */
  padWidth: number
}

const REF_SPECS: RefSpec[] = [
  { label: "campaign", fn: "next_campaign_ref", prefix: "CMP-", padWidth: 2 },
  { label: "lead", fn: "next_lead_ref", prefix: "LD-", padWidth: 4 },
]

const RPC_DENY_SPECS = [
  { label: "promote_campaign_leads", fn: "promote_campaign_leads" as const, args: { p_ids: [] as string[], p_trigger: "bulk" } },
  { label: "unpromote_campaign_lead", fn: "unpromote_campaign_lead" as const, args: { p_campaign_lead_id: "00000000-0000-4000-8000-000000000000" } },
] as const

async function main(): Promise<void> {
  const env = assertEnvOrExit()
  const supabase = createClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } },
  )

  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim()
  const anon = anonKey
    ? createClient<Database>(env.NEXT_PUBLIC_SUPABASE_URL, anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      })
    : null

  for (const spec of REF_SPECS) {
    // A truncating generator repeats itself for a whole decade, so any run of
    // SAMPLE_SIZE consecutive values spans at most two distinct refs. Sampling
    // one pair would only catch it ~90% of the time — whenever the pair happens
    // not to straddle a decade boundary — and a test that passes nine runs in
    // ten is worse than none.
    const SAMPLE_SIZE = 12
    const refs: string[] = []
    let rpcError = ""

    for (let i = 0; i < SAMPLE_SIZE; i += 1) {
      const { data, error } = await supabase.rpc(spec.fn)
      if (error || typeof data !== "string") {
        rpcError = error?.message ?? "no data"
        break
      }
      refs.push(data)
    }

    if (rpcError) {
      fail(`${spec.label} ref generator callable`, rpcError)
      continue
    }

    // Shape: prefix plus digits, never narrower than the historical floor.
    const shape = new RegExp(`^${spec.prefix}\\d{${spec.padWidth},}$`)
    const malformed = refs.filter((ref) => !shape.test(ref))
    if (malformed.length === 0) {
      pass(
        `${spec.label} ref keeps its ${spec.padWidth}-digit floor`,
        `${refs[0]} … ${refs[refs.length - 1]}`,
      )
    } else {
      fail(
        `${spec.label} ref keeps its ${spec.padWidth}-digit floor`,
        `malformed: ${malformed.join(", ")}`,
      )
    }

    const numbers = refs.map((ref) => Number(ref.slice(spec.prefix.length)))
    const gaps = numbers.slice(1).map((n, i) => n - numbers[i]!)
    const allByOne = gaps.every((gap) => gap === 1)
    const distinct = new Set(refs).size === refs.length

    // Three failures in one assertion, all of which have actually happened or
    // were one edit away:
    //   gap 0 -> lpad() truncated and consecutive refs collided (the Phase 1 bug)
    //   gap 2 -> nextval() evaluated twice per ref, burning the sequence
    //   dupes -> any other path to a ref that is not unique
    if (allByOne && distinct) {
      pass(
        `${spec.label} ref advances by one across ${SAMPLE_SIZE} values`,
        `${numbers[0]} -> ${numbers[numbers.length - 1]}`,
      )
    } else {
      fail(
        `${spec.label} ref advances by one across ${SAMPLE_SIZE} values`,
        `gaps ${gaps.join(",")}${distinct ? "" : " and duplicate refs"} in ${refs.join(", ")}`,
      )
    }

    if (anon) {
      const { error } = await anon.rpc(spec.fn)
      if (error) {
        pass(`${spec.label} ref generator not executable by anon`)
      } else {
        fail(
          `${spec.label} ref generator not executable by anon`,
          "RPC succeeded — see DB.md §7.1.2, ALL TABLES never covered functions",
        )
      }
    } else {
      skip(
        `${spec.label} ref generator not executable by anon`,
        "set NEXT_PUBLIC_SUPABASE_ANON_KEY to assert",
      )
    }
  }

  for (const spec of RPC_DENY_SPECS) {
    if (anon) {
      const { error } = await anon.rpc(spec.fn, spec.args as never)
      if (error) {
        pass(`${spec.label} not executable by anon`)
      } else {
        fail(
          `${spec.label} not executable by anon`,
          "RPC succeeded — see DB.md §7.1.2",
        )
      }
    } else {
      skip(`${spec.label} not executable by anon`, "set NEXT_PUBLIC_SUPABASE_ANON_KEY to assert")
    }
  }

  if (anon) {
    const { error } = await anon.from("v_exportable_leads").select("id").limit(1)
    if (error) {
      pass("v_exportable_leads not readable by anon")
    } else {
      fail(
        "v_exportable_leads not readable by anon",
        "SELECT succeeded — see DB.md §7.1.2",
      )
    }
  } else {
    skip("v_exportable_leads not readable by anon", "set NEXT_PUBLIC_SUPABASE_ANON_KEY to assert")
  }

  const passed = results.filter((r) => r.state === "pass").length
  const skipped = results.filter((r) => r.state === "skip").length
  const failed = results.filter((r) => r.state === "fail").length
  const asserted = results.length - skipped
  console.log(
    `\n${passed}/${asserted} checks passed${skipped > 0 ? `, ${skipped} skipped` : ""}`,
  )
  if (failed > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
