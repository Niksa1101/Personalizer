"use client"

import { useState } from "react"

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
  const [recordingFailed, setRecordingFailed] = useState(false)
  const [beforeFailed, setBeforeFailed] = useState(false)
  const [afterFailed, setAfterFailed] = useState(false)

  const recordingAvailable =
    detail.recording &&
    !detail.recording.purged_at &&
    detail.recording.local_path &&
    !recordingFailed

  const showBefore =
    detail.recording?.screenshot_before_path && !beforeFailed
  const showAfter =
    detail.recording?.screenshot_after_path && !afterFailed

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
            onError={() => setRecordingFailed(true)}
          />
        ) : (
          <div className="space-y-2 text-sm text-muted-foreground">
            <p>
              {detail.recording?.purged_at
                ? `Raw recording purged after ${detail.recordingRetentionDays} days.`
                : recordingFailed
                  ? "Recording file is missing or unplayable."
                  : "No recording yet."}
            </p>
            {!detail.recording?.purged_at ? (
              <RetryStepButton
                campaignLeadId={campaignLeadId}
                step="recording"
                disabled={status === "processing"}
              />
            ) : null}
          </div>
        )}
        {showBefore || showAfter ? (
          <div className="grid grid-cols-2 gap-2">
            {showBefore ? (
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
                  onError={() => setBeforeFailed(true)}
                />
              </a>
            ) : null}
            {showAfter ? (
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
                  onError={() => setAfterFailed(true)}
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
