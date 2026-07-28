import { Badge } from "@/components/ui/badge"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import type { EnvHealthEntry } from "@/lib/env-health"

type EnvHealthCardProps = {
  entries: EnvHealthEntry[]
  redisIndicator?: React.ReactNode
}

export function EnvHealthCard({ entries, redisIndicator }: EnvHealthCardProps) {
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle>Environment</CardTitle>
            <CardDescription>
              Required variables for boot. Only presence is shown — never values.
            </CardDescription>
          </div>
          {redisIndicator}
        </div>
      </CardHeader>
      <CardContent>
        <ul className="space-y-2">
          {entries.map((entry) => (
            <li
              key={entry.name}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-3 py-2 text-sm"
            >
              <span className="font-mono text-xs">{entry.name}</span>
              <div className="flex items-center gap-2">
                {entry.informational ? (
                  <span className="text-xs text-muted-foreground">
                    {entry.informational}
                  </span>
                ) : null}
                <Badge variant={entry.present ? "default" : "destructive"}>
                  {entry.present ? "Present" : "Missing"}
                </Badge>
              </div>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  )
}
