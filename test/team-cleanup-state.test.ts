import { expect, test } from "bun:test"
import { setupDb } from "./helpers"
import { beginCleanup, blockCleanup, advanceCleanup, finishCleanup, assertTeamAcceptsWork, withTeamOperation, deliverMemberPrompt } from "../src/team-cleanup-state"
import { setupDeps } from "./helpers"

test("cleanup CAS excludes concurrent operations and blocked phases are retryable", () => {
  const db = setupDb()
  try {
    const first = beginCleanup(db, "team")
    expect(() => beginCleanup(db, "team")).toThrow("already in progress")
    expect(() => assertTeamAcceptsWork(db, "team")).toThrow("pending")
    advanceCleanup(db, first, "cancelling")
    blockCleanup(db, first, new Error("inbox failed"))
    expect(() => assertTeamAcceptsWork(db, "team")).toThrow()
    const next = beginCleanup(db, "team")
    expect(() => advanceCleanup(db, first, "removing")).toThrow("ownership")
    finishCleanup(db, first)
    expect(() => beginCleanup(db, "team")).toThrow()
    finishCleanup(db, next)
    expect(() => assertTeamAcceptsWork(db, "team")).not.toThrow()
  } finally { db.close() }
})

test("lifecycle operations cannot overlap across cleanup, merge or spawn", async () => {
  const db = setupDb()
  let release: () => void = () => undefined
  const barrier = new Promise<void>(resolve => { release = resolve })
  const first = withTeamOperation(db, ["team"], () => barrier)
  await expect(withTeamOperation(db, ["team"], async () => undefined)).rejects.toThrow("Another lifecycle")
  release()
  await first
  await expect(withTeamOperation(db, ["team"], async () => "ok")).resolves.toBe("ok")
  db.close()
})

test("an admission from a terminated process does not permanently block lifecycle", async () => {
  const db = setupDb()
  const child = Bun.spawn(["bun", "-e", "process.exit(0)"], { stdout: "ignore", stderr: "ignore" })
  await child.exited
  db.run("INSERT INTO team_spawn_admission(id,team_id,owner_pid) VALUES('abandoned','team',?)", [child.pid])
  await expect(withTeamOperation(db, ["team"], async () => "recovered")).resolves.toBe("recovered")
  expect(db.query("SELECT id FROM team_spawn_admission").all()).toEqual([])
  db.close()
})

test("an in-flight member delivery blocks destructive lifecycle until it settles", async () => {
  const deps = setupDeps()
  let finish: () => void = () => undefined
  deps.client.session.promptAsync = () => new Promise(resolve => { finish = () => resolve({}) })
  deliverMemberPrompt(deps.db, deps.client, "team", { sessionID: "worker", parts: [{ type: "text", text: "work" }] })
  await expect(withTeamOperation(deps.db, ["team"], async () => undefined)).rejects.toThrow("pending spawn admissions")
  finish()
  await new Promise(resolve => setTimeout(resolve, 0))
  await expect(withTeamOperation(deps.db, ["team"], async () => "ok")).resolves.toBe("ok")
  deps.db.close()
})
