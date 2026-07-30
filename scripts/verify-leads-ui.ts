/**
 * Phase 13 UI verification — drives the real /leads interface in Chromium.
 *
 * The Phase 13 review closed on server-side evidence: `verify:leads` proves the
 * routes, the RPCs, and the SSE frames, but nothing in it ever rendered the
 * table. That mattered, because the two worst findings of that review (frozen
 * table state after a mutation, and Realtime connection churn) were both
 * client-side and both invisible to exactly the checks that were green.
 *
 * Every leg here asserts through the DOM the operator actually sees, and where
 * a mutation is involved, re-reads the database to confirm the two agree.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs"
import path from "node:path"

import ffmpegPath from "ffmpeg-static"
import { type Browser, type Page } from "playwright"
import { createClient } from "@supabase/supabase-js"

import type { Database } from "../lib/database.types"
import { SILENCE_MS } from "../lib/dashboard-connection"
import { assertEnvOrExit } from "../lib/env-node"
import { closeQueueConnections } from "../lib/queue"
import { runProcess } from "../lib/video/spawn"
import { pendingJobIds, removeJobsThisRunOrphaned } from "./queue-sweep"
import {
  createUiHarness,
  launchAuthenticatedPage,
  loginSessionCookie,
  printUiSummary,
  probeServer,
  UI_BASE_URL,
} from "./fixtures/ui-harness"

const { results, pass, fail, skip } = createUiHarness()
const BASE_URL = UI_BASE_URL

const CHECKS = [
  "drawer opens without a new stream connection",
  "intro_missing offers the assign-intro link",
  "clearing the website URL persists null",
  "clearing the only identifier is refused with a usable remedy",
  "name-only edit re-queues without a full restart",
  "new-leads pill adds rows",
  "selecting a row does not open its drawer",
  "bulk delete refreshes the table",
  "stream loss degrades to polling and recovers",
  "drawer recording decodes and advances",
  "drawer final video decodes and advances",
  "drawer shows purged copy",
  "drawer shows missing-or-unplayable copy with re-record button",
  "drawer drops screenshot tile when file gone",
] as const

const FFMPEG = ffmpegPath!

async function generatePipelineFixtureMp4(outputPath: string): Promise<void> {
  mkdirSync(path.dirname(outputPath), { recursive: true })
  await runProcess(FFMPEG, [
    "-y",
    "-f",
    "lavfi",
    "-i",
    "testsrc=duration=2:size=320x240:rate=15",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=2",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-movflags",
    "+faststart",
    "-shortest",
    outputPath,
  ])
}

/**
 * Assert a drawer `<video>` decodes H.264+AAC and the clock advances. A missing
 * element is a leg failure, not a throw — one regression must not hide the rest.
 */
async function assertDrawerVideoPlayback(
  page: Page,
  videoIndex: number,
  urlPattern: RegExp,
): Promise<{ ok: true; detail: string } | { ok: false; detail: string }> {
  let saw206 = false
  const onResponse = (response: { url: () => string; status: () => number }) => {
    if (urlPattern.test(response.url()) && response.status() === 206) {
      saw206 = true
    }
  }
  page.on("response", onResponse)

  try {
    const videos = page.locator("section video")
    const count = await videos.count()
    if (count <= videoIndex) {
      return {
        ok: false,
        detail: `expected video[${videoIndex}], found ${count}`,
      }
    }

    const video = videos.nth(videoIndex)
    let attached = true
    await video.waitFor({ state: "attached", timeout: 10_000 }).catch(() => {
      attached = false
    })
    if (!attached) {
      return { ok: false, detail: "video element never appeared" }
    }

    let playRejected = false
    await video.evaluate(async (el) => {
      const v = el as HTMLVideoElement
      v.muted = true
      try {
        await v.play()
      } catch {
        // waitForFunction below surfaces the real failure.
      }
    }).catch(() => {
      playRejected = true
    })
    if (playRejected) {
      return { ok: false, detail: "play() threw before playback could settle" }
    }

    try {
      await page.waitForFunction(
        (idx) => {
          const v = document.querySelectorAll("section video")[
            idx
          ] as HTMLVideoElement | undefined
          if (!v) return false
          if (v.error !== null) {
            throw new Error(`video.error code ${v.error.code}`)
          }
          return v.readyState >= 3 && v.videoWidth > 0 && v.currentTime >= 0.2
        },
        videoIndex,
        { timeout: 20_000, polling: 100 },
      )
    } catch (error) {
      const diag = await page.evaluate((idx) => {
        const v = document.querySelectorAll("section video")[
          idx
        ] as HTMLVideoElement | undefined
        if (!v) return "element missing"
        return JSON.stringify({
          error: v.error?.code ?? null,
          readyState: v.readyState,
          videoWidth: v.videoWidth,
          currentTime: v.currentTime,
          networkState: v.networkState,
        })
      }, videoIndex)
      const reason =
        error instanceof Error && error.message.includes("video.error")
          ? error.message
          : `playback did not settle: ${diag}`
      return {
        ok: false,
        detail: `${reason}${saw206 ? "" : " (no 206 observed)"}`,
      }
    }

    return {
      ok: true,
      detail: saw206 ? "decoded, advanced, 206 seen" : "decoded and advanced",
    }
  } finally {
    page.off("response", onResponse)
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function skipAll(reason: string): void {
  for (const name of CHECKS) skip(name, reason)
}

/** Screenshot on failure — a red leg with no picture costs a whole re-run. */
async function shoot(page: Page, label: string): Promise<void> {
  try {
    await page.screenshot({
      path: `.verify-ui/${label}.png`,
      fullPage: true,
    })
    console.log(`      screenshot → .verify-ui/${label}.png`)
  } catch {
    // Screenshots are diagnostics, never the reason a leg fails.
  }
}

async function main(): Promise<void> {
  const env = assertEnvOrExit()
  const supabase = createClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } },
  )

  if (!(await probeServer())) {
    skipAll("dev server not running")
    printUiSummary(results)
    return
  }

  const login = await loginSessionCookie(env.APP_PASSWORD)
  if ("reason" in login) {
    skipAll(login.reason)
    printUiSummary(results)
    return
  }

  const runId = Date.now().toString(36)
  let campaignId: string | null = null
  const leadIds: string[] = []
  let browser: Browser | null = null
  const mediaDirAbs = path.join(env.LOCAL_STORAGE_ROOT, "verify", runId)
  const mediaRelPath = `verify/${runId}/fixture.mp4`
  // The re-queue leg enqueues through the dev server, so this script leaks
  // pipeline jobs exactly like verify:leads does — just from the other side of
  // the HTTP boundary.
  const pendingJobIdsAtStart = await pendingJobIds()

  try {
    const { data: campaign, error: campaignError } = await supabase
      .from("campaigns")
      .insert({
        name: `Verify UI ${runId}`,
        slug: `verify-ui-${runId}`,
        landing_template: "<html></html>",
        merge_layout: "bubble_br",
        pip_scale: 0.2,
        viewport_width: 1920,
        viewport_height: 1080,
        nav_timeout_ms: 120_000,
      })
      .select("id")
      .single()

    if (campaignError || !campaign) {
      skipAll(`could not seed campaign: ${campaignError?.message}`)
      printUiSummary(results)
      return
    }
    campaignId = campaign.id
    let seedError = ""

    /** Seeds one lead + campaign_lead pair and returns both ids and the ref. */
    async function seedLead(
      key: string,
      lead: Database["public"]["Tables"]["leads"]["Insert"],
      cl: Omit<
        Database["public"]["Tables"]["campaign_leads"]["Insert"],
        "campaign_id" | "lead_id" | "slug"
      >,
    ): Promise<{ id: string; leadId: string; ref: string } | null> {
      const { data: leadRow, error: leadError } = await supabase
        .from("leads")
        .insert(lead)
        .select("id, ref")
        .single()
      if (leadError || !leadRow) {
        seedError = `leads insert (${key}): ${leadError?.message ?? "no row"}`
        return null
      }
      leadIds.push(leadRow.id)

      const { data: clRow, error: clError } = await supabase
        .from("campaign_leads")
        .insert({
          campaign_id: campaignId!,
          lead_id: leadRow.id,
          slug: `verify-ui-${runId}-${key}`,
          ...cl,
        })
        .select("id")
        .single()
      if (clError || !clRow) {
        seedError = `campaign_leads insert (${key}): ${clError?.message ?? "no row"}`
        return null
      }

      return { id: clRow.id, leadId: leadRow.id, ref: leadRow.ref }
    }

    const deleteA = await seedLead(
      "del-a",
      { company: `UI Delete A ${runId}`, domain: `ui-del-a-${runId}.example.com` },
      { status: "queued", current_step: "recording" },
    )
    const deleteB = await seedLead(
      "del-b",
      { company: `UI Delete B ${runId}`, domain: `ui-del-b-${runId}.example.com` },
      { status: "queued", current_step: "recording" },
    )
    const introLead = await seedLead(
      "intro",
      { company: `UI Intro ${runId}`, domain: `ui-intro-${runId}.example.com` },
      {
        status: "paused",
        current_step: "merge",
        error_code: "intro_missing",
        attempt_count: 1,
      },
    )
    // The email matters: `leads_identifiable_ck` is `domain OR email`, so a lead
    // whose URL is its only identifier cannot legally have that URL cleared.
    // Without the email this fixture asserted the guard, not the happy path.
    const urlLead = await seedLead(
      "url",
      {
        company: `UI Url ${runId}`,
        domain: `ui-url-${runId}.example.com`,
        website_url: `https://ui-url-${runId}.example.com`,
        email: `ui-url-${runId}@example.com`,
      },
      {
        status: "failed",
        current_step: "recording",
        error_code: "browser_crash",
        attempt_count: 1,
      },
    )
    // The mirror of urlLead: no email, so its URL *is* its only identifier and
    // clearing it must be refused with copy that names a remedy which works.
    const guardLead = await seedLead(
      "guard",
      {
        company: `UI Guard ${runId}`,
        domain: `ui-guard-${runId}.example.com`,
        website_url: `https://ui-guard-${runId}.example.com`,
      },
      {
        status: "failed",
        current_step: "recording",
        error_code: "browser_crash",
        attempt_count: 1,
      },
    )
    const requeueLead = await seedLead(
      "requeue",
      {
        company: `UI Requeue ${runId}`,
        domain: `ui-requeue-${runId}.example.com`,
        website_url: `https://ui-requeue-${runId}.example.com`,
      },
      {
        status: "failed",
        current_step: "deploy",
        error_code: "netlify_failure",
        attempt_count: 1,
      },
    )
    const mediaLead = await seedLead(
      "media",
      {
        company: `UI Media ${runId}`,
        domain: `ui-media-${runId}.example.com`,
      },
      {
        status: "queued",
        current_step: "deploy",
      },
    )
    const purgedLead = await seedLead(
      "purged",
      {
        company: `UI Purged ${runId}`,
        domain: `ui-purged-${runId}.example.com`,
      },
      {
        status: "deployed",
        current_step: "deploy",
        netlify_url: `https://example.com/verify-ui-${runId}-purged`,
      },
    )
    const missingLead = await seedLead(
      "missing",
      {
        company: `UI Missing ${runId}`,
        domain: `ui-missing-${runId}.example.com`,
      },
      {
        status: "failed",
        current_step: "recording",
        error_code: "missing_asset",
        attempt_count: 1,
      },
    )
    const screenshotLead = await seedLead(
      "shots",
      {
        company: `UI Shots ${runId}`,
        domain: `ui-shots-${runId}.example.com`,
      },
      {
        status: "deployed",
        current_step: "deploy",
        netlify_url: `https://example.com/verify-ui-${runId}-shots`,
      },
    )

    if (
      !deleteA ||
      !deleteB ||
      !introLead ||
      !urlLead ||
      !guardLead ||
      !requeueLead ||
      !mediaLead ||
      !purgedLead ||
      !missingLead ||
      !screenshotLead
    ) {
      skipAll(`could not seed fixture leads — ${seedError}`)
      printUiSummary(results)
      return
    }

    // Reproduces Phase 13 finding 9's trap: a URL-change note from an *earlier*
    // cycle, already superseded by a `resumed` event. A name-only edit after
    // this must still derive `resume`. Unbounded, the note matches forever and
    // every later re-queue silently becomes a full re-record.
    await supabase.from("pipeline_events").insert({
      campaign_lead_id: requeueLead.id,
      kind: "note",
      message: "Website URL changed from https://old.example.com",
    })
    await sleep(50)
    await supabase.from("pipeline_events").insert({
      campaign_lead_id: requeueLead.id,
      kind: "resumed",
      message: "Lead manually resumed and re-queued.",
    })

    // Real H.264+AAC bytes — same codec settings as the pipeline — so the
    // playback legs prove decode, not merely that a route returns bytes.
    try {
      await generatePipelineFixtureMp4(path.join(mediaDirAbs, "fixture.mp4"))
    } catch (error) {
      skip(
        "drawer recording decodes and advances",
        `fixture encode failed: ${(error as Error).message}`,
      )
      skip(
        "drawer final video decodes and advances",
        `fixture encode failed: ${(error as Error).message}`,
      )
    }

    const fixtureReady = existsSync(path.join(mediaDirAbs, "fixture.mp4"))
    if (fixtureReady) {
      const { data: recordingRow, error: recordingError } = await supabase
        .from("recordings")
        .insert({
          lead_id: mediaLead.leadId,
          local_path: mediaRelPath,
          purged_at: null,
          duration_ms: 2000,
        })
        .select("id")
        .single()

      if (recordingError || !recordingRow) {
        skip(
          "drawer recording decodes and advances",
          `recordings insert: ${recordingError?.message ?? "no row"}`,
        )
        skip(
          "drawer final video decodes and advances",
          `recordings insert: ${recordingError?.message ?? "no row"}`,
        )
      } else {
        await supabase
          .from("campaign_leads")
          .update({ recording_id: recordingRow.id })
          .eq("id", mediaLead.id)

        const { data: videoRow, error: videoError } = await supabase
          .from("videos")
          .insert({
            campaign_lead_id: mediaLead.id,
            web_path: mediaRelPath,
            web_public_url: null,
            duration_ms: 2000,
            used_speed_floor: false,
          })
          .select("id")
          .single()

        if (videoError || !videoRow) {
          skip(
            "drawer recording decodes and advances",
            `videos insert: ${videoError?.message ?? "no row"}`,
          )
          skip(
            "drawer final video decodes and advances",
            `videos insert: ${videoError?.message ?? "no row"}`,
          )
        } else {
          await supabase
            .from("campaign_leads")
            .update({ video_id: videoRow.id })
            .eq("id", mediaLead.id)
        }
      }
    }

    const shotRelPrefix = `verify/${runId}/shots`
    const { data: purgedRecording, error: purgedRecordingError } =
      await supabase
        .from("recordings")
        .insert({
          lead_id: purgedLead.leadId,
          local_path: null,
          purged_at: new Date().toISOString(),
          duration_ms: 2000,
        })
        .select("id")
        .single()
    if (purgedRecordingError || !purgedRecording) {
      skip(
        "drawer shows purged copy",
        `recordings insert: ${purgedRecordingError?.message ?? "no row"}`,
      )
    } else {
      await supabase
        .from("campaign_leads")
        .update({ recording_id: purgedRecording.id })
        .eq("id", purgedLead.id)
    }

    const { data: missingRecording, error: missingRecordingError } =
      await supabase
        .from("recordings")
        .insert({
          lead_id: missingLead.leadId,
          local_path: `${shotRelPrefix}/gone-recording.mp4`,
          purged_at: null,
          duration_ms: 2000,
        })
        .select("id")
        .single()
    if (missingRecordingError || !missingRecording) {
      skip(
        "drawer shows missing-or-unplayable copy with re-record button",
        `recordings insert: ${missingRecordingError?.message ?? "no row"}`,
      )
    } else {
      await supabase
        .from("campaign_leads")
        .update({ recording_id: missingRecording.id })
        .eq("id", missingLead.id)
    }

    const { data: screenshotRecording, error: screenshotRecordingError } =
      await supabase
        .from("recordings")
        .insert({
          lead_id: screenshotLead.leadId,
          local_path: `${shotRelPrefix}/recording.mp4`,
          purged_at: null,
          duration_ms: 2000,
          screenshot_before_path: `${shotRelPrefix}/before.png`,
          screenshot_after_path: `${shotRelPrefix}/after.png`,
        })
        .select("id")
        .single()
    if (screenshotRecordingError || !screenshotRecording) {
      skip(
        "drawer drops screenshot tile when file gone",
        `recordings insert: ${screenshotRecordingError?.message ?? "no row"}`,
      )
    } else {
      await supabase
        .from("campaign_leads")
        .update({ recording_id: screenshotRecording.id })
        .eq("id", screenshotLead.id)
    }

    const launched = await launchAuthenticatedPage(login.cookie)
    browser = launched.browser
    const context = launched.context
    const page = launched.page

    // Every request to the stream route, for the churn assertion.
    const streamRequests: string[] = []
    page.on("request", (request) => {
      if (request.url().includes("/api/stream/leads")) {
        streamRequests.push(request.url())
      }
    })

    const consoleErrors: string[] = []
    page.on("pageerror", (error) => consoleErrors.push(error.message))

    const leadsUrl = `${BASE_URL}/leads?campaign=${campaignId}&sort=ref&order=asc`
    await page.goto(leadsUrl, { waitUntil: "domcontentloaded" })

    // ---- leg 1: opening a drawer must not rebuild the stream --------------
    await page.getByText(deleteA.ref, { exact: true }).first().waitFor()
    // The stream connects on mount; let it settle so the baseline is the
    // steady state and not a half-finished mount.
    await sleep(2_000)
    const beforeDrawer = streamRequests.length

    await page.getByText(introLead.ref, { exact: true }).first().click()
    await page
      .getByRole("heading", { name: new RegExp(introLead.ref) })
      .first()
      .waitFor({ timeout: 10_000 })
      .catch(() => undefined)
    await sleep(2_000)

    const afterDrawer = streamRequests.length
    if (beforeDrawer === 0) {
      fail(
        "drawer opens without a new stream connection",
        "no stream connection was opened at all",
      )
      await shoot(page, "drawer-stream")
    } else if (afterDrawer > beforeDrawer) {
      fail(
        "drawer opens without a new stream connection",
        `${afterDrawer - beforeDrawer} extra connection(s) — churn is back`,
      )
      await shoot(page, "drawer-stream")
    } else {
      pass(
        "drawer opens without a new stream connection",
        `${beforeDrawer} connection, unchanged`,
      )
    }

    // ---- leg 2: intro_missing error block links to /intros ----------------
    const introCopy = page.getByText(
      "The campaign has no intro video assigned.",
    )
    const assignIntro = page.getByRole("link", { name: "Assign intro" })
    if ((await introCopy.count()) === 0) {
      fail(
        "intro_missing offers the assign-intro link",
        "error sentence not rendered in the drawer",
      )
      await shoot(page, "intro-missing")
    } else if ((await assignIntro.count()) === 0) {
      fail(
        "intro_missing offers the assign-intro link",
        "sentence rendered but no Assign intro link",
      )
      await shoot(page, "intro-missing")
    } else {
      const href = await assignIntro.first().getAttribute("href")
      if (href !== "/intros") {
        fail(
          "intro_missing offers the assign-intro link",
          `href was ${href ?? "(none)"}`,
        )
      } else {
        await assignIntro.first().click()
        await page.waitForURL("**/intros", { timeout: 10_000 }).catch(() => undefined)
        if (new URL(page.url()).pathname === "/intros") {
          pass("intro_missing offers the assign-intro link", "navigates to /intros")
        } else {
          fail(
            "intro_missing offers the assign-intro link",
            `click landed on ${page.url()}`,
          )
          await shoot(page, "intro-missing-nav")
        }
      }
    }

    // ---- leg 3: clearing the website URL persists as null -----------------
    await page.goto(`${leadsUrl}&lead=${urlLead.id}`, {
      waitUntil: "domcontentloaded",
    })
    const urlField = page.locator("#website_url")
    await urlField.waitFor({ timeout: 10_000 })
    await urlField.fill("")
    await page.getByRole("button", { name: "Save", exact: true }).click()
    await page
      .getByText("Lead saved")
      .first()
      .waitFor({ timeout: 10_000 })
      .catch(() => undefined)
    await sleep(1_000)

    const { data: clearedLead } = await supabase
      .from("leads")
      .select("website_url")
      .eq("id", urlLead.leadId)
      .maybeSingle()

    if (clearedLead?.website_url == null) {
      pass("clearing the website URL persists null")
    } else {
      fail(
        "clearing the website URL persists null",
        `still ${clearedLead.website_url}`,
      )
      await shoot(page, "clear-url")
    }

    // ---- leg 3b: clearing the *only* identifier must be refused -----------
    await page.goto(`${leadsUrl}&lead=${guardLead.id}`, {
      waitUntil: "domcontentloaded",
    })
    const guardField = page.locator("#website_url")
    await guardField.waitFor({ timeout: 10_000 })
    await guardField.fill("")
    await page.getByRole("button", { name: "Save", exact: true }).click()
    await sleep(2_500)

    const { data: guardRow } = await supabase
      .from("leads")
      .select("website_url")
      .eq("id", guardLead.leadId)
      .maybeSingle()
    const guardCopy = await page
      .getByText(/A lead needs a website URL or an email address/)
      .count()

    if (guardRow?.website_url == null) {
      fail(
        "clearing the only identifier is refused with a usable remedy",
        "the URL was cleared — leads_identifiable_ck should have refused it",
      )
    } else if (guardCopy === 0) {
      // The old copy offered "a company name", which does not satisfy
      // `domain IS NOT NULL OR email IS NOT NULL` — the operator would edit a
      // field that cannot clear the error.
      fail(
        "clearing the only identifier is refused with a usable remedy",
        "refused, but the message does not name a remedy that works",
      )
      await shoot(page, "identifier-guard")
    } else {
      pass("clearing the only identifier is refused with a usable remedy")
    }

    // ---- leg 4: a name-only edit must re-queue, not restart ---------------
    await page.goto(`${leadsUrl}&lead=${requeueLead.id}`, {
      waitUntil: "domcontentloaded",
    })
    const companyField = page.locator("#company")
    await companyField.waitFor({ timeout: 10_000 })
    await companyField.fill(`UI Requeue ${runId} edited`)
    await page.getByRole("button", { name: "Save", exact: true }).click()

    const requeueButton = page.getByRole("button", {
      name: "Re-queue this lead",
    })
    let requeueVisible = true
    await requeueButton.waitFor({ timeout: 10_000 }).catch(() => {
      requeueVisible = false
    })

    if (!requeueVisible) {
      fail(
        "name-only edit re-queues without a full restart",
        "Re-queue button never appeared after Save",
      )
      await shoot(page, "requeue")
    } else {
      await requeueButton.click()
      await page
        .getByText("Lead re-queued")
        .first()
        .waitFor({ timeout: 10_000 })
        .catch(() => undefined)
      await sleep(1_000)

      const { data: requeued } = await supabase
        .from("campaign_leads")
        .select("status, current_step")
        .eq("id", requeueLead.id)
        .maybeSingle()

      if (requeued?.status !== "queued") {
        fail(
          "name-only edit re-queues without a full restart",
          `status is ${requeued?.status ?? "(missing)"}`,
        )
        await shoot(page, "requeue")
      } else if (requeued.current_step === "recording") {
        // `buildRetryPatch("restart")` is the only path that rewinds the step
        // to recording — i.e. the stale-note regression is back.
        fail(
          "name-only edit re-queues without a full restart",
          "current_step rewound to recording — derived restart",
        )
      } else {
        pass(
          "name-only edit re-queues without a full restart",
          `queued at ${requeued.current_step}`,
        )
      }
    }

    // ---- leg 5: the new-leads pill actually adds rows ---------------------
    await page.goto(leadsUrl, { waitUntil: "domcontentloaded" })
    await page.getByText(deleteA.ref, { exact: true }).first().waitFor()
    await sleep(2_000)

    const inserted = await seedLead(
      "pill",
      { company: `UI Pill ${runId}`, domain: `ui-pill-${runId}.example.com` },
      { status: "queued", current_step: "recording" },
    )

    if (!inserted) {
      fail("new-leads pill adds rows", "could not insert the new lead")
    } else {
      const pill = page.getByRole("button", { name: /new lead.*refresh/i })
      let pillShown = true
      await pill.waitFor({ timeout: 20_000 }).catch(() => {
        pillShown = false
      })

      if (!pillShown) {
        fail("new-leads pill adds rows", "pill never appeared after an INSERT")
        await shoot(page, "pill")
      } else {
        await pill.click()
        let rowAppeared = true
        await page
          .getByText(inserted.ref, { exact: true })
          .first()
          .waitFor({ timeout: 15_000 })
          .catch(() => {
            rowAppeared = false
          })

        if (rowAppeared) {
          pass("new-leads pill adds rows", `${inserted.ref} rendered`)
        } else {
          fail(
            "new-leads pill adds rows",
            "pill cleared but the new row never rendered",
          )
          await shoot(page, "pill")
        }
      }
    }

    // ---- leg 6: selecting a row must not also open its drawer -------------
    const overlay = page.locator('[data-slot="sheet-overlay"]')
    await page.getByLabel(`Select ${deleteA.ref}`).click({ timeout: 8_000 })
    await sleep(700)

    const openedDrawer = (await overlay.count()) > 0
    const selectedOne =
      (await page.getByText("1 selected", { exact: true }).count()) > 0

    if (openedDrawer) {
      fail(
        "selecting a row does not open its drawer",
        "ticking the checkbox opened the drawer — the row click was not suppressed",
      )
      await shoot(page, "select-opens-drawer")
      // Get back to a usable table so the bulk-delete leg still reports.
      await page.keyboard.press("Escape")
      await overlay
        .first()
        .waitFor({ state: "detached", timeout: 5_000 })
        .catch(() => undefined)
    } else if (!selectedOne) {
      fail(
        "selecting a row does not open its drawer",
        "no drawer, but the bulk bar never showed a selection either",
      )
      await shoot(page, "select-no-selection")
    } else {
      pass("selecting a row does not open its drawer")
    }

    // ---- leg 7: bulk delete refreshes the table without a reload ----------
    await page.getByLabel(`Select ${deleteB.ref}`).click({ timeout: 8_000 })
    await page.getByText("2 selected", { exact: true }).waitFor({ timeout: 8_000 })

    // The drawer mounts a delete dialog with the same button name, so the
    // confirm is scoped by the plural title only the bulk dialog uses.
    await page
      .getByRole("button", { name: "Remove from campaign" })
      .first()
      .click({ timeout: 8_000 })

    const bulkDialog = page.locator('[data-slot="dialog-content"]', {
      hasText: "Remove 2 leads from campaign?",
    })
    await bulkDialog.waitFor({ timeout: 8_000 })
    await bulkDialog
      .getByRole("button", { name: "Remove from campaign" })
      .click({ timeout: 8_000 })

    let rowsGone = true
    await page
      .getByText(deleteA.ref, { exact: true })
      .first()
      .waitFor({ state: "detached", timeout: 20_000 })
      .catch(() => {
        rowsGone = false
      })

    const { count: remaining } = await supabase
      .from("campaign_leads")
      .select("id", { count: "exact", head: true })
      .in("id", [deleteA.id, deleteB.id])

    if (!rowsGone) {
      // Phase 13 finding 3 exactly: the mutation lands but the table keeps
      // rendering frozen `result` state until the operator reloads by hand.
      fail(
        "bulk delete refreshes the table",
        "rows still rendered after the delete — table did not refresh",
      )
      await shoot(page, "bulk-delete")
    } else if ((remaining ?? 0) !== 0) {
      fail(
        "bulk delete refreshes the table",
        `rows left the table but ${remaining} row(s) remain in the database`,
      )
    } else {
      pass("bulk delete refreshes the table")
    }

    // ---- leg 7: losing the stream degrades to polling, then recovers ------
    const liveBadge = page.getByText("Live", { exact: true })
    let wasLive = true
    await liveBadge
      .first()
      .waitFor({ timeout: 15_000 })
      .catch(() => {
        wasLive = false
      })

    if (!wasLive) {
      fail(
        "stream loss degrades to polling and recovers",
        "indicator never reached Live to begin with",
      )
      await shoot(page, "connectivity")
    } else {
      await context.setOffline(true)
      const offlineAt = Date.now()

      // Bounded by the client's own contract, not a guess: if the dropped
      // socket never raises `error`, the only remaining degrade path is the
      // silence timer, so anything under SILENCE_MS would fail a healthy build.
      let degraded = true
      await page
        .getByText("Polling", { exact: true })
        .first()
        .waitFor({ timeout: SILENCE_MS + 10_000 })
        .catch(() => {
          degraded = false
        })
      const degradedMs = Date.now() - offlineAt

      await context.setOffline(false)

      let recovered = true
      await page
        .getByText("Live", { exact: true })
        .first()
        .waitFor({ timeout: 30_000 })
        .catch(() => {
          recovered = false
        })

      if (!degraded) {
        fail(
          "stream loss degrades to polling and recovers",
          `indicator stayed Live ${SILENCE_MS + 10_000}ms after the socket went down`,
        )
        await shoot(page, "connectivity")
      } else if (!recovered) {
        fail(
          "stream loss degrades to polling and recovers",
          "degraded to Polling but never returned to Live",
        )
        await shoot(page, "connectivity")
      } else {
        pass(
          "stream loss degrades to polling and recovers",
          `polling after ${degradedMs}ms, live again after reconnect`,
        )
      }
    }

    // ---- legs 10–11: in-drawer video decode + playback --------------------
    const playbackAlreadySkipped = results.some(
      (r) =>
        r.name === "drawer recording decodes and advances" &&
        r.state === "skip",
    )

    if (!playbackAlreadySkipped) {
      let chromeBrowser: Browser | null = null
      let chromePage: Page | null = null

      // Only a launch failure means "Chrome is not installed". Anything that
      // goes wrong afterwards is a real defect and must fail the leg — a
      // catch-all here reported a broken /leads page as a skip and exited 0.
      try {
        const chrome = await launchAuthenticatedPage(login.cookie, BASE_URL, {
          channel: "chrome",
        })
        chromeBrowser = chrome.browser
        chromePage = chrome.page
      } catch (error) {
        skip(
          "drawer recording decodes and advances",
          `Google Chrome not available: ${(error as Error).message}`,
        )
        skip(
          "drawer final video decodes and advances",
          `Google Chrome not available: ${(error as Error).message}`,
        )
      }

      if (chromePage) {
       const page = chromePage
       try {
        const canPlay = await page.evaluate(() =>
          document
            .createElement("video")
            .canPlayType('video/mp4; codecs="avc1.42E01E"'),
        )
        if (!canPlay) {
          skip(
            "drawer recording decodes and advances",
            "browser cannot decode H.264",
          )
          skip(
            "drawer final video decodes and advances",
            "browser cannot decode H.264",
          )
        } else {
          await page.goto(`${leadsUrl}&lead=${mediaLead.id}`, {
            waitUntil: "domcontentloaded",
          })

          let drawerReady = true
          await page
            .getByRole("heading", { name: "Recording" })
            .waitFor({ timeout: 15_000 })
            .catch(() => {
              drawerReady = false
            })

          if (!drawerReady) {
            fail(
              "drawer recording decodes and advances",
              "drawer never finished loading — Recording section missing",
            )
            fail(
              "drawer final video decodes and advances",
              "drawer never finished loading — Recording section missing",
            )
            await shoot(page, "playback-drawer-loading")
          } else {
            const recordingResult = await assertDrawerVideoPlayback(
              page,
              0,
              new RegExp(`/api/leads/${mediaLead.id}/recording`),
            )
            if (recordingResult.ok) {
              pass(
                "drawer recording decodes and advances",
                recordingResult.detail,
              )
            } else {
              fail(
                "drawer recording decodes and advances",
                recordingResult.detail,
              )
              await shoot(page, "playback-recording")
            }

            const finalResult = await assertDrawerVideoPlayback(
              page,
              1,
              new RegExp(`/api/leads/${mediaLead.id}/video`),
            )
            if (finalResult.ok) {
              pass(
                "drawer final video decodes and advances",
                finalResult.detail,
              )
            } else {
              fail(
                "drawer final video decodes and advances",
                finalResult.detail,
              )
              await shoot(page, "playback-final")
            }
          }
        }
       } catch (error) {
        // Chrome launched, so this is a defect in the screen or the run — not
        // a missing browser. Report the legs that have not spoken yet; the
        // ones that already failed keep their specific reason.
        const detail = `unexpected error: ${(error as Error).message}`
        for (const name of [
          "drawer recording decodes and advances",
          "drawer final video decodes and advances",
        ] as const) {
          if (!results.some((entry) => entry.name === name)) fail(name, detail)
        }
       } finally {
        await chromeBrowser?.close().catch(() => undefined)
       }
      }
    }

    // ---- Phase 16: purged / missing / screenshot drawer copy ----------------
    await page.goto(`${leadsUrl}&lead=${purgedLead.id}`, {
      waitUntil: "domcontentloaded",
    })
    await page
      .getByRole("heading", { name: "Recording" })
      .waitFor({ timeout: 10_000 })
      .catch(() => undefined)
    await sleep(1_500)
    const recordingSection = page
      .locator("section")
      .filter({ has: page.getByRole("heading", { name: "Recording", exact: true }) })
    const purgedCopy = recordingSection.getByText(
      /Raw recording purged after \d+ days\./,
    )
    const purgedRerecord = recordingSection.getByRole("button", {
      name: "Re-record",
    })
    if ((await purgedCopy.count()) > 0 && (await purgedRerecord.count()) === 0) {
      pass("drawer shows purged copy")
    } else if ((await purgedCopy.count()) === 0) {
      fail("drawer shows purged copy", "purged sentence not rendered")
      await shoot(page, "purged-copy")
    } else {
      fail(
        "drawer shows purged copy",
        `Re-record button still visible (count=${await purgedRerecord.count()})`,
      )
      await shoot(page, "purged-copy")
    }

    await page.goto(`${leadsUrl}&lead=${missingLead.id}`, {
      waitUntil: "domcontentloaded",
    })
    const missingCopy = page.getByText("Recording file is missing or unplayable.")
    const rerecord = page.getByRole("button", { name: "Re-record" })
    await page
      .locator("section video")
      .first()
      .waitFor({ state: "attached", timeout: 10_000 })
      .catch(() => undefined)
    await sleep(1_500)
    if ((await missingCopy.count()) === 0) {
      fail(
        "drawer shows missing-or-unplayable copy with re-record button",
        "missing/unplayable sentence not rendered",
      )
      await shoot(page, "missing-copy")
    } else if ((await rerecord.count()) === 0) {
      fail(
        "drawer shows missing-or-unplayable copy with re-record button",
        "sentence rendered but no Re-record button",
      )
      await shoot(page, "missing-copy")
    } else {
      pass(
        "drawer shows missing-or-unplayable copy with re-record button",
      )
    }

    await page.goto(`${leadsUrl}&lead=${screenshotLead.id}`, {
      waitUntil: "domcontentloaded",
    })
    await page
      .getByRole("heading", { name: "Recording" })
      .waitFor({ timeout: 10_000 })
      .catch(() => undefined)
    await sleep(1_500)
    const beforeImg = page.locator('img[alt="Before scroll"]')
    const afterImg = page.locator('img[alt="After scroll"]')
    if ((await beforeImg.count()) > 0 || (await afterImg.count()) > 0) {
      fail(
        "drawer drops screenshot tile when file gone",
        `tiles still rendered (before=${await beforeImg.count()} after=${await afterImg.count()})`,
      )
      await shoot(page, "screenshot-tiles")
    } else {
      pass("drawer drops screenshot tile when file gone")
    }

    if (consoleErrors.length > 0) {
      console.log(
        `\nNOTE  ${consoleErrors.length} uncaught page error(s): ${consoleErrors
          .slice(0, 3)
          .join(" | ")}`,
      )
    }
  } finally {
    await browser?.close().catch(() => undefined)
    rmSync(mediaDirAbs, { recursive: true, force: true })
    if (campaignId) {
      await supabase.from("campaigns").delete().eq("id", campaignId)
    }
    for (const leadId of leadIds) {
      await supabase.from("leads").delete().eq("id", leadId)
    }

    // Strictly after the row deletions: the sweep decides what to drop by
    // asking which campaign_leads still exist.
    await removeJobsThisRunOrphaned(supabase, pendingJobIdsAtStart)
    await closeQueueConnections()
  }

  printUiSummary(results)
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => {
    // Mirrors verify:leads. The queue sweep opens a Redis connection, and with
    // Redis unreachable the ioredis reconnect loop outlives
    // closeQueueConnections() and keeps the event loop alive forever — the
    // script would print its summary and then hang (Phase 13 finding 11).
    // Safe here and only here: teardown is fully awaited above, so there is no
    // in-flight work left to truncate.
    process.exit(results.some((result) => result.state === "fail") ? 1 : 0)
  })
