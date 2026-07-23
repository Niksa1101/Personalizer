import { spawn } from "node:child_process"

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

export function runProcess(
  binary: string,
  args: string[],
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { windowsHide: true })
    let stdout = ""
    let stderr = ""
    let settled = false

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill("SIGKILL")
      reject(new FfmpegTimeoutError())
    }, timeoutMs)

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString()
    })
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString()
    })

    child.on("error", (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })

    child.on("close", (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
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
