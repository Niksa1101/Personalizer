import { z } from "zod"

import type { Database } from "@/lib/database.types"

export type IntroVideoRow = Database["public"]["Tables"]["intro_videos"]["Row"]

export const renameIntroSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1, "Name is required").max(120),
})

/** Keep in step with `next.config.ts` `proxyClientMaxBodySize`. */
export const INTRO_MAX_UPLOAD_BYTES = 500 * 1024 * 1024

/** Max drift between stored `duration_ms` and ffprobe after D5 normalize (~33 ms observed). */
export const INTRO_DURATION_MS_TOLERANCE = 500

export const assignIntroSchema = z.object({
  introId: z.string().uuid(),
  selectedIds: z.array(z.string().uuid()),
})

export type RenameIntroInput = z.infer<typeof renameIntroSchema>
export type AssignIntroInput = z.infer<typeof assignIntroSchema>

/** Intersect client selection with the presented assignable set. */
export function reconcileIntroCampaignSelection(
  presentedIds: readonly string[],
  selectedIds: readonly string[],
): { selected: string[]; deselected: string[] } {
  const presented = new Set(presentedIds)
  const selected = selectedIds.filter((id) => presented.has(id))
  const selectedSet = new Set(selected)
  const deselected = presentedIds.filter((id) => !selectedSet.has(id))
  return { selected, deselected }
}

/** Basename minus extension — default display name on upload (D14/D20). */
export function nameFromFilename(filename: string): string {
  const base = filename.replace(/\\/g, "/").split("/").pop() ?? filename
  const dot = base.lastIndexOf(".")
  if (dot <= 0) return base
  return base.slice(0, dot)
}
