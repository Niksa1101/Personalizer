/**
 * Operator tool: list foreign Netlify paths and optionally adopt them.
 *
 * npm run adopt:site            — lists foreign paths, adopts nothing
 * npm run adopt:site -- --apply   — inserts after typed confirmation
 */

import { createInterface } from "node:readline/promises"
import { stdin as input, stdout as output } from "node:process"

import { assertEnvOrExit } from "../lib/env-node"
import { classifySiteFiles } from "../worker/deploy/ownership"
import { createNetlifyClient } from "../worker/deploy/netlify"
import {
  insertAdoptedSitePaths,
  listAdoptedSitePaths,
  listOwnedSitePaths,
} from "../worker/db"

async function main(): Promise<void> {
  assertEnvOrExit()
  const apply = process.argv.includes("--apply")
  const siteId = process.env.NETLIFY_SITE_ID!.trim()

  const client = createNetlifyClient({})
  const sitePaths = await client.listSiteFiles()
  if (!sitePaths) {
    console.error("Could not list site files — Netlify /files response unavailable.")
    process.exitCode = 1
    return
  }

  const [owned, adopted] = await Promise.all([
    listOwnedSitePaths(),
    listAdoptedSitePaths(siteId),
  ])

  const report = classifySiteFiles({
    sitePaths,
    ownedPaths: new Set(owned),
    adoptedPaths: new Set(adopted),
  })

  if (report.foreign.length === 0) {
    console.log("No foreign paths — nothing to adopt.")
    if (report.orphaned.length > 0) {
      console.log(
        `Note: ${report.orphaned.length} app-shaped path(s) with no row (reported, not foreign).`,
      )
    }
    return
  }

  console.log(`Site ${siteId} holds ${report.foreign.length} foreign path(s):\n`)
  for (const path of report.foreign) {
    console.log(`  ${path}`)
  }

  if (!apply) {
    console.log("\nDry run — pass --apply to adopt these paths.")
    return
  }

  const count = report.foreign.length
  const rl = createInterface({ input, output })
  const answer = await rl.question(`Adopt ${count} path(s)? type the number: `)
  rl.close()

  if (answer.trim() !== String(count)) {
    console.error("Confirmation did not match — adoption cancelled.")
    process.exitCode = 1
    return
  }

  const inserted = await insertAdoptedSitePaths({
    siteId,
    paths: report.foreign,
    note: "operator adopt:site",
  })
  console.log(`Adopted ${inserted} path(s).`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
