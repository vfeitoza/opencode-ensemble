import { expect, test } from "bun:test"
import { createSidebarLoader, type SidebarLoadState } from "../src/tui-sidebar-state"

test("RPC failure is an error state and retry can restore an actual empty response", async () => {
  let fail = true
  const states: SidebarLoadState[] = []
  const loader = createSidebarLoader(async () => { if (fail) throw new Error("rpc.unavailable"); return null }, state => states.push(state))
  await loader.load("session-a")
  expect(states.at(-1)).toMatchObject({ status: "error", message: "rpc.unavailable" })
  fail = false
  await loader.load("session-a")
  expect(states.at(-1)).toEqual({ status: "ready", data: null })
})

test("late old-session response cannot replace the new session's data", async () => {
  let resolveOld: (value: null) => void = () => undefined
  let calls = 0
  const states: SidebarLoadState[] = []
  const loader = createSidebarLoader(() => ++calls === 1 ? new Promise(resolve => { resolveOld = resolve }) : Promise.resolve({ team: "new-team", members: [], tasks: { pending: 0, done: 0 } }), state => states.push(state))
  const old = loader.load("old")
  await loader.load("new")
  resolveOld(null)
  await old
  expect(states.at(-1)).toMatchObject({ status: "ready", data: { team: "new-team" } })
})
