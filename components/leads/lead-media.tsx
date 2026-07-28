"use client"

import { PacingIndicator } from "@/components/leads/pacing-indicator"
import { RetryStepButton } from "@/components/leads/retry-step-button"
import type { LeadDetail } from "@/lib/leads"
import type { LeadStatus } from "@/lib/campaign-types"

type LeadMediaProps = {
  detail: LeadDetail
  campaignLeadId: string
  status: LeadStatus
}

export function LeadMedia({ detail, campaignLeadId, status }: LeadMediaProps) {
  const recordingAvailable =
    detail.recording &&
    !detail.recording.purged_at &&
    detail.recording.local_path

  return (
    <section className="space-y-4">
      <div className="space-y-2">
        <h3 className="text-sm font-medium">Recording</h3>
        {recordingAvailable ? (
          <video
            controls
            playsInline
            preload="metadata"
            className="aspect-video w-full rounded-md border bg-black"
            src={`/api/leads/${campaignLeadId}/recording`}
          />
        ) : (
          <div className="space-y-2 text-sm text-muted-foreground">
            <p>
              {detail.recording?.purged_at
                ? "Recording was purged or is missing."
                : "No recording yet."}
            </p>
            <RetryStepButton
              campaignLeadId={campaignLeadId}
              step="recording"
              disabled={status === "processing"}
            />
          </div>
        )}
        {detail.recording?.screenshot_before_path ||
        detail.recording?.screenshot_after_path ? (
          <div className="grid grid-cols-2 gap-2">
            {detail.recording.screenshot_before_path ? (
              <a
                href={`/api/leads/${campaignLeadId}/screenshot?which=before`}
                target="_blank"
                rel="noreferrer"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`/api/leads/${campaignLeadId}/screenshot?which=before`}
                  alt="Before scroll"
                  className="rounded-md border"
                />
              </a>
            ) : null}
            {detail.recording?.screenshot_after_path ? (
              <a
                href={`/api/leads/${campaignLeadId}/screenshot?which=after`}
                target="_blank"
                rel="noreferrer"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`/api/leads/${campaignLeadId}/screenshot?which=after`}
                  alt="After scroll"
                  className="rounded-md border"
                />
              </a>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-medium">Final video</h3>
          <PacingIndicator
            video={detail.video}
            maxStretchFactor={detail.maxStretchFactor}
          />
        </div>
        {detail.video ? (
          <video
            controls
            playsInline
            preload="metadata"
            className="aspect-video w-full rounded-md border bg-black"
            src={
              detail.video.web_public_url ??
              `/api/leads/${campaignLeadId}/video`
            }
          />
        ) : (
          <p className="text-sm text-muted-foreground">No merged video yet.</p>
        )}
      </div>
    </section>
  )
}
