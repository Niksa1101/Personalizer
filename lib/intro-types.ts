import { z } from "zod"

import type { Database } from "@/lib/database.types"

export type IntroVideoRow = Database["public"]["Tables"]["intro_videos"]["Row"]

export const renameIntroSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1, "Name is required").max(120),
})

export const assignIntroSchema = z.object({
  introId: z.string().uuid(),
  campaignIds: z.array(z.string().uuid()).min(1, "Select at least one campaign"),
})

export type RenameIntroInput = z.infer<typeof renameIntroSchema>
export type AssignIntroInput = z.infer<typeof assignIntroSchema>

/** Basename minus extension — default display name on upload (D14/D20). */
export function nameFromFilename(filename: string): string {
  const base = filename.replace(/\\/g, "/").split("/").pop() ?? filename
  const dot = base.lastIndexOf(".")
  if (dot <= 0) return base
  return base.slice(0, dot)
}
