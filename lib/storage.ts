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

/** In-flight Playwright WebM workspace: `tmp/rec-{token}/`. */
export function recordingTmpDirRelPath(token: string): string {
  return `tmp/rec-${token}`
}
