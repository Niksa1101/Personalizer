"use client"

import { Loader2, Upload } from "lucide-react"
import { useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"

export function UploadCard() {
  const router = useRouter()
  const inputRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)

  async function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ""
    if (!file) return

    setBusy(true)
    try {
      const body = new FormData()
      body.append("file", file)

      const response = await fetch("/api/intros", {
        method: "POST",
        body,
      })

      const payload = (await response.json()) as { id?: string; error?: string }

      if (!response.ok || !payload.id) {
        toast.error(payload.error ?? "Upload failed")
        return
      }

      toast.success("Intro uploaded and normalized")
      router.refresh()
    } catch {
      toast.error("Upload failed — check your connection and try again")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="max-w-xl">
      <CardHeader>
        <CardTitle>Upload intro</CardTitle>
        <CardDescription>
          Any format FFmpeg can decode. The file is normalized to 1080p / 30fps
          before it is saved — large uploads may take a few minutes.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <input
          ref={inputRef}
          type="file"
          accept="video/*"
          className="sr-only"
          disabled={busy}
          onChange={handleFileChange}
        />
        <Button
          type="button"
          disabled={busy}
          onClick={() => inputRef.current?.click()}
        >
          {busy ? <Loader2 className="animate-spin" /> : <Upload />}
          {busy ? "Uploading & processing…" : "Choose video file"}
        </Button>
      </CardContent>
    </Card>
  )
}
