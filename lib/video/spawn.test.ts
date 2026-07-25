import { strict as assert } from "node:assert"
import { describe, it } from "node:test"

import { ProcessAbortedError, runProcess } from "./spawn"

describe("runProcess abort support", () => {
  it("rejects with ProcessAbortedError when the signal is already aborted", async () => {
    const controller = new AbortController()
    controller.abort()

    await assert.rejects(
      runProcess("/nonexistent/binary/path", [], {
        signal: controller.signal,
      }),
      (error: unknown) => {
        assert.ok(error instanceof ProcessAbortedError)
        return true
      },
    )
  })

  it("rejects with ProcessAbortedError when the signal aborts mid-run", async () => {
    const controller = new AbortController()
    const binary = process.platform === "win32" ? "cmd.exe" : "sleep"
    const args = process.platform === "win32" ? ["/c", "timeout", "/t", "30"] : ["30"]

    const pending = runProcess(binary, args, { signal: controller.signal })

    controller.abort()

    await assert.rejects(pending, (error: unknown) => {
      assert.ok(error instanceof ProcessAbortedError)
      return true
    })
  })
})
