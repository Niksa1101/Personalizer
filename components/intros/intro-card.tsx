"use client"

import { Clapperboard, MoreHorizontal, Pencil, Trash2, Users } from "lucide-react"
import { useState } from "react"

import { AssignIntroDialog } from "@/components/intros/assign-intro-dialog"
import { DeleteIntroDialog } from "@/components/intros/delete-intro-dialog"
import { RenameIntroDialog } from "@/components/intros/rename-intro-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { formatFileSize, formatIntroDuration } from "@/lib/intro-format"
import type { AssignableCampaign, IntroWithUsage } from "@/lib/intros"

type IntroCardProps = {
  intro: IntroWithUsage
  assignableCampaigns: AssignableCampaign[]
}

export function IntroCard({ intro, assignableCampaigns }: IntroCardProps) {
  const [renameOpen, setRenameOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [assignOpen, setAssignOpen] = useState(false)

  const posterUrl = intro.poster_path
    ? `/api/intros/${intro.id}/poster`
    : null

  return (
    <>
      <Card>
        {posterUrl ? (
          // Authenticated local API route — next/image adds no benefit here.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={posterUrl}
            alt=""
            className="aspect-video w-full object-cover"
          />
        ) : (
          <div className="flex aspect-video w-full items-center justify-center bg-muted/40 text-muted-foreground">
            <Clapperboard className="size-10" />
          </div>
        )}

        <CardHeader>
          <CardTitle>{intro.name}</CardTitle>
          <CardDescription>
            {intro.width}×{intro.height} · {formatFileSize(intro.file_size_bytes)}
          </CardDescription>
          <CardAction>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button variant="ghost" size="icon-sm" aria-label="Intro actions" />
                }
              >
                <MoreHorizontal />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => setRenameOpen(true)}>
                  <Pencil />
                  Rename
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setAssignOpen(true)}>
                  <Users />
                  Assign to campaigns
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
                  onClick={() => setDeleteOpen(true)}
                >
                  <Trash2 />
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </CardAction>
        </CardHeader>

        <CardContent className="space-y-4">
          <p className="font-mono text-3xl font-semibold tracking-tight">
            {formatIntroDuration(intro.duration_ms)}
          </p>

          <video
            controls
            playsInline
            preload="metadata"
            poster={posterUrl ?? undefined}
            src={`/api/intros/${intro.id}/file`}
            className="aspect-video w-full rounded-2xl bg-black"
          />

          <div className="space-y-2 text-sm text-muted-foreground">
            <p>
              Used by{" "}
              <span className="font-medium text-foreground">
                {intro.campaigns.length}
              </span>{" "}
              {intro.campaigns.length === 1 ? "campaign" : "campaigns"}
            </p>
            {intro.campaigns.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {intro.campaigns.map((campaign) => (
                  <Badge key={campaign.id} variant="secondary">
                    {campaign.name}
                  </Badge>
                ))}
              </div>
            ) : (
              <p>Not assigned to any campaign yet.</p>
            )}
          </div>
        </CardContent>

        <CardFooter>
          <Button variant="outline" size="sm" onClick={() => setAssignOpen(true)}>
            Assign to campaigns
          </Button>
        </CardFooter>
      </Card>

      <RenameIntroDialog
        intro={intro}
        open={renameOpen}
        onOpenChange={setRenameOpen}
      />
      <DeleteIntroDialog
        intro={intro}
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
      />
      <AssignIntroDialog
        intro={intro}
        campaigns={assignableCampaigns}
        open={assignOpen}
        onOpenChange={setAssignOpen}
      />
    </>
  )
}
