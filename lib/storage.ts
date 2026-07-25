import path from "node:path"

import { assertEnv } from "@/lib/env"

/** Resolve a POSIX-relative storage path to an absolute filesystem path (D12). */
export function storageAbs(relPosix: string): string {
  const segments = relPosix.split("/").filter(Boolean)
  return path.join(assertEnv().LOCAL_STORAGE_ROOT, ...segments)
}

/** Normalized intro video: `intros/{id}.mp4` */
export function introRelPath(id: string): string {
  return `intros/${id}.mp4`
}

/** Intro poster frame: `intros/{id}.jpg` */
export function introPosterRelPath(id: string): string {
  return `intros/${id}.jpg`
}

/** Temp upload while normalization is in flight. */
export function introUploadTempRelPath(id: string): string {
  return `tmp/${id}-upload`
}

/** Temp CSV pending preview/commit. */
export function importUploadTempRelPath(token: string): string {
  return `tmp/import-${token}.csv`
}

/** Persisted CSV audit copy for a committed batch. */
export function importBatchCsvRelPath(slug: string): string {
  return `imports/${slug}.csv`
}

/** Raw Playwright capture: `{batch}/{lead-slug}/recording.mp4`. */
export function recordingRelPath(batchId: string, leadSlugValue: string): string {
  return `${batchId}/${leadSlugValue}/recording.mp4`
}

/** Debug screenshot before scroll: `{batch}/{lead-slug}/screenshot-before.png`. */
export function screenshotBeforeRelPath(
  batchId: string,
  leadSlugValue: string,
): string {
  return `${batchId}/${leadSlugValue}/screenshot-before.png`
}

/** Debug screenshot after scroll: `{batch}/{lead-slug}/screenshot-after.png`. */
export function screenshotAfterRelPath(
  batchId: string,
  leadSlugValue: string,
): string {
  return `${batchId}/${leadSlugValue}/screenshot-after.png`
}

/** Temp in-flight Playwright WebM workspace: `tmp/rec-{token}/`. */
export function recordingTmpDirRelPath(token: string): string {
  return `tmp/rec-${token}`
}

/** 1080p master: `{outputDir}/final.mp4`. */
export function finalRelPath(outputDir: string): string {
  return `${outputDir}/final.mp4`
}

/** 720p local web copy: `{outputDir}/web.mp4`. */
export function webRelPath(outputDir: string): string {
  return `${outputDir}/web.mp4`
}

/** Landing-page poster frame: `{outputDir}/poster.jpg`. */
export function posterRelPath(outputDir: string): string {
  return `${outputDir}/poster.jpg`
}

/** Resolve the merge artifact directory (Tech.md §11). */
export function resolveMergeOutputDir(input: {
  recordingLocalPath: string | null
  videoMasterPath: string | null
}): string {
  if (input.videoMasterPath) {
    const parts = input.videoMasterPath.split("/").filter(Boolean)
    parts.pop()
    return parts.join("/")
  }
  if (input.recordingLocalPath) {
    const parts = input.recordingLocalPath.split("/").filter(Boolean)
    parts.pop()
    return parts.join("/")
  }
  throw new Error("Cannot resolve merge output directory")
}

export function mergeTempMasterRelPath(
  outputDir: string,
  jobRunId: string,
): string {
  return `${outputDir}/final.${jobRunId}.tmp.mp4`
}

export function mergeTempWebRelPath(outputDir: string, jobRunId: string): string {
  return `${outputDir}/web.${jobRunId}.tmp.mp4`
}

export function mergeTempPosterRelPath(
  outputDir: string,
  jobRunId: string,
): string {
  return `${outputDir}/poster.${jobRunId}.tmp.jpg`
}
