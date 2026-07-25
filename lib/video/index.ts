export { probe, type ProbeResult } from "@/lib/video/probe"
export {
  buildNormalizeIntroArgs,
  normalizeIntro,
  type NormalizeIntroInput,
} from "@/lib/video/normalize-intro"
export {
  buildMergeArgs,
  buildWebEncodeArgs,
  computeMergePlan,
  type MergePlan,
} from "@/lib/video/merge-plan"
export {
  decideMergeAction,
  type MergeAction,
} from "@/lib/video/merge-action"
export { extractPoster } from "@/lib/video/extract-poster"
export {
  FfmpegProcessError,
  FfmpegTimeoutError,
  ProcessAbortedError,
} from "@/lib/video/spawn"
