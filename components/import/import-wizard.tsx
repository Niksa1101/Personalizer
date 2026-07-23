"use client"

import { Loader2, Upload } from "lucide-react"
import { useRouter } from "next/navigation"
import { useEffect, useRef, useState } from "react"
import { toast } from "sonner"

import { ImportReport } from "@/components/import/import-report"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import type { CampaignListItem } from "@/lib/campaign-types"
import {
  IMPORT_FIELDS,
  UNMAPPED,
  type HeaderMapping,
  type ImportField,
  type PreviewResult,
} from "@/lib/import-types"

const FIELD_LABELS: Record<ImportField | typeof UNMAPPED, string> = {
  website_url: "Website URL",
  email: "Email",
  company: "Company",
  first_name: "First name",
  last_name: "Last name",
  full_name: "Full name",
  phone: "Phone",
  city: "City",
  state: "State",
  country: "Country",
  industry: "Industry",
  [UNMAPPED]: "Unmapped",
}

const MAPPING_OPTIONS = [UNMAPPED, ...IMPORT_FIELDS] as const

type ImportWizardProps = {
  campaigns: CampaignListItem[]
}

export function ImportWizard({ campaigns }: ImportWizardProps) {
  const router = useRouter()
  const inputRef = useRef<HTMLInputElement>(null)
  const previewDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [campaignId, setCampaignId] = useState(campaigns[0]?.id ?? "")
  const [filename, setFilename] = useState<string | null>(null)
  const [preview, setPreview] = useState<PreviewResult | null>(null)
  const [mapping, setMapping] = useState<HeaderMapping>({})
  const [busy, setBusy] = useState(false)
  const [committing, setCommitting] = useState(false)

  useEffect(() => {
    return () => {
      if (previewDebounceRef.current) {
        clearTimeout(previewDebounceRef.current)
      }
    }
  }, [])

  async function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ""
    if (!file || !campaignId) return

    setBusy(true)
    setFilename(file.name)
    try {
      const body = new FormData()
      body.append("file", file)
      body.append("campaignId", campaignId)

      const response = await fetch("/api/import", { method: "POST", body })
      const payload = (await response.json()) as PreviewResult & {
        error?: string
      }

      if (!response.ok) {
        toast.error(payload.error ?? "Preview failed")
        setPreview(null)
        return
      }

      setPreview(payload)
      setMapping(payload.mapping)
      toast.success("Preview ready — review mapping before committing")
    } catch {
      toast.error("Preview failed — check your connection and try again")
      setPreview(null)
    } finally {
      setBusy(false)
    }
  }

  async function refreshPreview(nextMapping: HeaderMapping) {
    if (!preview || !campaignId) return

    setBusy(true)
    try {
      const response = await fetch("/api/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: preview.token,
          campaignId,
          mapping: nextMapping,
        }),
      })

      const payload = (await response.json()) as PreviewResult & {
        error?: string
      }

      if (!response.ok) {
        toast.error(payload.error ?? "Could not refresh preview")
        return
      }

      setPreview(payload)
      setMapping(payload.mapping)
    } catch {
      toast.error("Could not refresh preview")
    } finally {
      setBusy(false)
    }
  }

  function handleMappingChange(header: string, value: string | null) {
    if (!value) return
    if (mapping[header] === value) return

    const nextMapping = {
      ...mapping,
      [header]: value as ImportField | typeof UNMAPPED,
    }
    setMapping(nextMapping)

    if (previewDebounceRef.current) {
      clearTimeout(previewDebounceRef.current)
    }
    previewDebounceRef.current = setTimeout(() => {
      void refreshPreview(nextMapping)
    }, 300)
  }

  async function handleCommit() {
    if (!preview || !filename || !campaignId) return

    setCommitting(true)
    try {
      const response = await fetch("/api/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: preview.token,
          campaignId,
          filename,
          mapping,
        }),
      })

      const payload = (await response.json()) as {
        batchId?: string
        error?: string
      }

      if (!response.ok || !payload.batchId) {
        toast.error(payload.error ?? "Import failed")
        return
      }

      toast.success("Import committed")
      router.push(`/import/${payload.batchId}`)
      router.refresh()
    } catch {
      toast.error("Import failed — check your connection and try again")
    } finally {
      setCommitting(false)
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <Card className="max-w-3xl">
        <CardHeader>
          <CardTitle>Upload CSV</CardTitle>
          <CardDescription>
            Choose the campaign this file belongs to, then select the CSV.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="max-w-md space-y-2">
            <label htmlFor="import-campaign" className="text-sm font-medium">
              Campaign
            </label>
            <Select
              value={campaignId}
              onValueChange={(value) => {
                if (!value) return
                setCampaignId(value)
                setPreview(null)
                setFilename(null)
              }}
            >
              <SelectTrigger id="import-campaign" className="w-full">
                <SelectValue placeholder="Select campaign" />
              </SelectTrigger>
              <SelectContent>
                {campaigns.map((campaign) => (
                  <SelectItem key={campaign.id} value={campaign.id}>
                    {campaign.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <input
            ref={inputRef}
            type="file"
            accept=".csv,text/csv"
            className="sr-only"
            disabled={busy || committing || !campaignId}
            onChange={handleFileChange}
          />
          <Button
            type="button"
            disabled={busy || committing || !campaignId}
            onClick={() => inputRef.current?.click()}
          >
            {busy ? <Loader2 className="animate-spin" /> : <Upload />}
            {busy ? "Parsing…" : filename ? "Choose a different file" : "Choose CSV file"}
          </Button>
          {filename ? (
            <p className="text-sm text-muted-foreground">Selected: {filename}</p>
          ) : null}
        </CardContent>
      </Card>

      {preview ? (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Header mapping</CardTitle>
              <CardDescription>
                Adjust any column that was mapped incorrectly. Counts update
                automatically.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>CSV column</TableHead>
                    <TableHead>Maps to</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {preview.headers.map((header) => (
                    <TableRow key={header}>
                      <TableCell className="font-medium">{header}</TableCell>
                      <TableCell>
                        <Select
                          value={mapping[header] ?? UNMAPPED}
                          onValueChange={(value) =>
                            handleMappingChange(header, value)
                          }
                        >
                          <SelectTrigger className="w-full max-w-xs">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {MAPPING_OPTIONS.map((field) => (
                              <SelectItem key={field} value={field}>
                                {FIELD_LABELS[field]}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          <ImportReport
            filename={filename ?? "import.csv"}
            campaignName={
              campaigns.find((campaign) => campaign.id === campaignId)?.name ??
              "Campaign"
            }
            createdAt={new Date().toISOString()}
            delimiter={preview.delimiter}
            hadBom={preview.hadBom}
            rowCount={preview.rowCount}
            counts={preview.counts}
            existsList={preview.existsList}
            rejectedRows={preview.rejectedRows}
            sampleRows={preview.sampleRows}
          />

          <div className="flex items-center gap-3">
            <Button
              type="button"
              disabled={committing || busy}
              onClick={handleCommit}
            >
              {committing ? (
                <Loader2 className="animate-spin" />
              ) : null}
              {committing ? "Committing…" : "Commit import"}
            </Button>
            <p className="text-sm text-muted-foreground">
              Queued leads will be ready for the worker (Phase 7 enqueues them).
            </p>
          </div>
        </>
      ) : null}
    </div>
  )
}
