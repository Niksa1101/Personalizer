import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { planClearQueue } from "@/lib/queue-clear-plan"

type FakeJob = {
  id?: string
  data?: { campaignLeadId?: string }
  remove: () => Promise<void>
}

describe("planClearQueue", () => {
  it("returns one batched id list", async () => {
    const jobs: FakeJob[] = [
      {
        id: "a",
        data: { campaignLeadId: "lead-a" },
        remove: async () => {},
      },
      {
        id: "b",
        data: { campaignLeadId: "lead-b" },
        remove: async () => {},
      },
    ]
    const plan = await planClearQueue(jobs as never)
    assert.deepEqual(plan.leadIds, ["lead-a", "lead-b"])
    assert.equal(plan.removeFailedCount, 0)
  })

  it("skips jobs without campaignLeadId", async () => {
    const jobs: FakeJob[] = [
      { id: undefined, data: {}, remove: async () => {} },
      {
        id: "x",
        data: { campaignLeadId: "lead-x" },
        remove: async () => {},
      },
    ]
    const plan = await planClearQueue(jobs as never)
    assert.deepEqual(plan.leadIds, ["lead-x"])
  })

  it("counts remove() rejections as removeFailedCount", async () => {
    const jobs: FakeJob[] = [
      {
        id: "locked",
        data: { campaignLeadId: "lead-locked" },
        remove: async () => {
          throw new Error("locked")
        },
      },
      {
        id: "ok",
        data: { campaignLeadId: "lead-ok" },
        remove: async () => {},
      },
    ]
    const plan = await planClearQueue(jobs as never)
    assert.deepEqual(plan.leadIds, ["lead-ok"])
    assert.equal(plan.removeFailedCount, 1)
  })
})
