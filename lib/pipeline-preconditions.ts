export type MergePreconditionResult =
  | "pause_intro_missing"
  | "record_first"
  | "proceed"

export function mergePrecondition(input: {
  hasIntro: boolean
  hasUsableRecording: boolean
  alreadyRedirected: boolean
}): MergePreconditionResult {
  if (!input.hasIntro) return "pause_intro_missing"
  if (!input.hasUsableRecording && !input.alreadyRedirected) return "record_first"
  return "proceed"
}
