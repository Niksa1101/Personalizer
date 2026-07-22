"use client"

import { useState } from "react"
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

export function LoginForm({ next }: { next: string }) {
  const router = useRouter()
  const [password, setPassword] = useState("")
  const [showPassword, setShowPassword] = useState(false)
  const [capsLockOn, setCapsLockOn] = useState(false)
  const [showError, setShowError] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  const handleKeyEvent = (event: React.KeyboardEvent<HTMLInputElement>) => {
    setCapsLockOn(event.getModifierState("CapsLock"))
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (submitting) return

    setSubmitting(true)
    setShowError(false)

    try {
      const response = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      })

      if (response.ok) {
        router.push(next)
        router.refresh()
        return
      }

      if (response.status === 401) {
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
                    disabled={submitting}
                    className="pr-10"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="absolute top-1/2 right-1 -translate-y-1/2"
                    onClick={() => setShowPassword((visible) => !visible)}
                    aria-label={showPassword ? "Hide password" : "Show password"}
                    disabled={submitting}
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

            {/* No countdown here, deliberately. A client-side attempt counter
                cannot observe the server's limiter: it reset on every reload
                (hiding a real lockout behind a bare "Incorrect password") and
                never decayed (inventing lockouts that had already expired). The
                server returns an identical 401 at every tier by design (D14),
                so the honest thing to show is that throttling exists, not a
                timer the client is guessing at. */}
            <div aria-live="polite">
              {showError ? (
                <Alert variant="destructive">
                  <AlertDescription>
                    Incorrect password. Repeated failures are temporarily
                    throttled — if it keeps failing, wait a minute and try
                    again.
                  </AlertDescription>
                </Alert>
              ) : null}
            </div>

            <Button
              type="submit"
              className="w-full"
              disabled={submitting || password.length === 0}
            >
              {submitting ? "Signing in…" : "Sign in"}
            </Button>
          </FieldGroup>
        </form>
      </CardContent>
    </Card>
  )
}
