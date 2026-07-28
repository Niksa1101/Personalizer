import { describe, it } from "node:test"
import assert from "node:assert/strict"

import { DRAWER_ACTION_IDS, ERROR_COPY, ERROR_CODES } from "@/lib/error-copy"

describe("error-copy exhaustiveness", () => {
  it("maps every ERROR_CODE", () => {
    for (const code of ERROR_CODES) {
      assert.ok(ERROR_COPY[code], `missing copy for ${code}`)
    }
  })

  it("references only declared drawer action ids", () => {
    const allowed = new Set<string>(DRAWER_ACTION_IDS)
    for (const code of ERROR_CODES) {
      const action = ERROR_COPY[code].action
      assert.ok(allowed.has(action.id), `${code} action ${action.id}`)
    }
  })

  it("uses /intros for assign-intro link actions", () => {
    for (const code of ERROR_CODES) {
      const action = ERROR_COPY[code].action
      if (action.id === "assign-intro") {
        assert.equal(action.href, "/intros")
      }
    }
  })
})
