"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { Eye, EyeOff } from "lucide-react"
import { toast } from "sonner"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Field,
  FieldContent,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"

const COUNTDOWN_60S = 60_000
const COUNTDOWN_15M = 15 * 60_000

function formatCountdown(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${seconds.toString().padStart(2, "0")}`
}

function countdownDuration(failures: number): number | null {
  if (failures >= 10) return COUNTDOWN_15M
  if (failures >= 5) return COUNTDOWN_60S
  return null
}

export function LoginForm({ next }: { next: string }) {
  const router = useRouter()
  const [password, setPassword] = useState("")
  const [showPassword, setShowPassword] = useState(false)
  const [capsLockOn, setCapsLockOn] = useState(false)
  const [showError, setShowError] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [countdownEndsAt, setCountdownEndsAt] = useState<number | null>(null)
  const [tick, setTick] = useState(0)
  const failuresRef = useRef(0)

  const countdownMs =
    countdownEndsAt === null ? 0 : Math.max(0, countdownEndsAt - tick)
  const countdownActive = countdownMs > 0

  useEffect(() => {
    if (countdownEndsAt === null) return
    const id = window.setInterval(() => setTick(Date.now()), 250)
    return () => window.clearInterval(id)
  }, [countdownEndsAt])

  const startCountdownIfNeeded = useCallback((nextFailures: number) => {
    const duration = countdownDuration(nextFailures)
    if (duration === null) {
      setCountdownEndsAt(null)
      return
    }
    setCountdownEndsAt(Date.now() + duration)
    setTick(Date.now())
  }, [])

  const handleKeyEvent = (event: React.KeyboardEvent<HTMLInputElement>) => {
    setCapsLockOn(event.getModifierState("CapsLock"))
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (submitting || countdownActive) return

    setSubmitting(true)
    setShowError(false)

    try {
      const response = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password, next }),
      })

      if (response.ok) {
        failuresRef.current = 0
        setCountdownEndsAt(null)
        router.push(next)
        router.refresh()
        return
      }

      if (response.status === 401) {
        failuresRef.current += 1
        startCountdownIfNeeded(failuresRef.current)
        setShowError(true)
        return
      }

      toast.error("Something went wrong. Please try again.")
    } catch {
      toast.error("Network error. Please try again.")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle>Sign in</CardTitle>
        <CardDescription>
          Enter the shared password to access Personalizer.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit}>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="password">Password</FieldLabel>
              <FieldContent>
                <div className="relative">
                  <Input
                    id="password"
                    name="password"
                    type={showPassword ? "text" : "password"}
                    autoComplete="current-password"
                    autoFocus
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    onKeyDown={handleKeyEvent}
                    onKeyUp={handleKeyEvent}
                    disabled={submitting || countdownActive}
                    className="pr-10"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="absolute top-1/2 right-1 -translate-y-1/2"
                    onClick={() => setShowPassword((visible) => !visible)}
                    aria-label={showPassword ? "Hide password" : "Show password"}
                    disabled={submitting || countdownActive}
                  >
                    {showPassword ? (
                      <EyeOff className="size-4" />
                    ) : (
                      <Eye className="size-4" />
                    )}
                  </Button>
                </div>
                {capsLockOn ? (
                  <p className="text-sm text-muted-foreground">
                    Caps Lock is on
                  </p>
                ) : null}
              </FieldContent>
            </Field>

            <div aria-live="polite">
              {showError ? (
                <Alert variant="destructive">
                  <AlertDescription>Incorrect password</AlertDescription>
                </Alert>
              ) : null}
              {countdownActive ? (
                <Alert>
                  <AlertDescription>
                    Too many attempts — try again in{" "}
                    {formatCountdown(countdownMs)}
                  </AlertDescription>
                </Alert>
              ) : null}
            </div>

            <Button
              type="submit"
              className="w-full"
              disabled={submitting || countdownActive || password.length === 0}
            >
              {submitting ? "Signing in…" : "Sign in"}
            </Button>
          </FieldGroup>
        </form>
      </CardContent>
    </Card>
  )
}
