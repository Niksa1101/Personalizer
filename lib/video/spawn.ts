import { spawn, type ChildProcess } from "node:child_process"

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000

export class FfmpegTimeoutError extends Error {
  constructor(message = "FFmpeg operation timed out after 10 minutes") {
    super(message)
    this.name = "FfmpegTimeoutError"
  }
}

export class FfmpegProcessError extends Error {
  readonly stderr: string

  constructor(message: string, stderr: string) {
    super(message)
    this.name = "FfmpegProcessError"
    this.stderr = stderr
  }
}

export class ProcessAbortedError extends Error {
  constructor(message = "Process aborted") {
    super(message)
    this.name = "ProcessAbortedError"
  }
}

export type RunProcessOptions = {
  timeoutMs?: number
  signal?: AbortSignal
}

export function runProcess(
  binary: string,
  args: string[],
  options?: number | RunProcessOptions,
): Promise<{ stdout: string; stderr: string }> {
  const resolved: RunProcessOptions =
    typeof options === "number" ? { timeoutMs: options } : (options ?? {})

  const timeoutMs = resolved.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const signal = resolved.signal

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ProcessAbortedError())
      return
    }

    const child = spawn(binary, args, { windowsHide: true })
    let stdout = ""
    let stderr = ""
    let settled = false

    const cleanup = () => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
    }

    const onAbort = () => {
      killChild(child)
      if (settled) return
      settled = true
      cleanup()
      reject(new ProcessAbortedError())
    }

    const timer = setTimeout(() => {
      killChild(child)
      if (settled) return
      settled = true
      cleanup()
      reject(new FfmpegTimeoutError())
    }, timeoutMs)

    signal?.addEventListener("abort", onAbort, { once: true })

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString()
    })
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString()
    })

    child.on("error", (error) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    })

    child.on("close", (code) => {
      if (settled) return
      settled = true
      cleanup()
      if (code === 0) {
        resolve({ stdout, stderr })
      } else {
        reject(
          new FfmpegProcessError(
            `Process exited with code ${code ?? "unknown"}`,
            stderr,
          ),
        )
      }
    })
  })
}

function killChild(child: ChildProcess): void {
  try {
    child.kill("SIGKILL")
  } catch {
    // Process may already be gone.
  }
}
