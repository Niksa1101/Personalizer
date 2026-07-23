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
