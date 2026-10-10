import { expect, test } from "bun:test"
import { createVerifiedInboxBridge } from "../src/v2-inbox"

test("CLI inbox bridge blocks a different server before any cancellation", async () => {
  let disposed = false
  const calls: string[][] = []
  await expect(createVerifiedInboxBridge({ register: async () => ({ dispose: async () => { disposed = true } }) }, "/project", async args => { calls.push(args); return { output: { nonce: "different" } } })).rejects.toThrow("identity mismatch")
  expect(disposed).toBe(true)
  expect(calls.every(args => args[0] === "rpc.call")).toBe(true)
})

test("CLI bridge re-verifies host identity before listing and cancelling", async () => {
  let identify: () => Promise<unknown> = async () => ({})
  const calls: string[] = []
  const bridge = await createVerifiedInboxBridge({ register: async (_definition, handlers) => { identify = handlers.identity!; return { dispose: async () => undefined } } }, "/project", async args => {
    calls.push(args[0]!)
    if (args[0] === "rpc.call") return { output: await identify() }
    if (args[0] === "session.inbox.list") return { data: [] }
    return undefined
  })
  await bridge.inbox.list({ sessionID: "ses-test" })
  await bridge.inbox.cancel({ sessionID: "ses-test", inboxID: "msg-owned" })
  expect(calls).toEqual(["rpc.call", "rpc.call", "session.inbox.list", "rpc.call", "session.inbox.cancel"])
})
