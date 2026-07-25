export type MergeAction =
  | "discard+full"
  | "full"
  | "web+upload"
  | "upload"
  | "skip"
  | "missing_asset"

export function decideMergeAction(input: {
  videoIdLinked: boolean
  hasRow: boolean
  encodedAt: string | null
  masterExists: boolean
  uploadedAt: string | null
  webExists: boolean
}): MergeAction {
  if (input.videoIdLinked && !input.encodedAt) {
    return "discard+full"
  }

  if (!input.videoIdLinked) {
    if (input.hasRow) return "discard+full"
    return "full"
  }

  if (!input.masterExists) {
    return "missing_asset"
  }

  if (input.uploadedAt) {
    return "skip"
  }

  if (input.webExists) {
    return "upload"
  }

  return "web+upload"
}

export function needsPosterSelfHeal(input: {
  posterPath: string | null
  posterExists: boolean
}): boolean {
  return input.posterPath == null || !input.posterExists
}
