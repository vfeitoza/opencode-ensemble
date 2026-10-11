import { expect, test } from "bun:test"
import { setupDeps, insertTeam, insertMember } from "./helpers"
import { stopAndPreserveMember } from "../src/member-stop"

test("waits for interrupt and preserves again after the writer's last commit", async () => {
  const deps = setupDeps()
  insertTeam(deps.db, "t1", "test", "lead")
  insertMember(deps.db, "t1", "worker", "ses-worker", "shutdown_requested")
  deps.db.run("INSERT INTO team_task(id,team_id,content,status,priority,assignee,time_created,time_updated) VALUES('task','t1','work','in_progress','medium','worker',0,0)")
  let running = true
  let commit = "A"
  const preserved: string[] = []
  let finish: () => void = () => undefined
  let reached: () => void = () => undefined
  const entered = new Promise<void>(resolve => { reached = resolve })
  deps.client.session.execution = async () => running ? "running" : "idle"
  deps.preserveMember = async () => { preserved.push(commit); return "owned-ref" }
  deps.client.session.abort = async () => { reached(); await new Promise<void>(resolve => { finish = resolve }); commit = "B"; running = false }
  const stopping = stopAndPreserveMember(deps, "t1", "worker", { force: true })
  await entered
  expect(preserved).toEqual(["A"])
  expect(deps.db.query("SELECT assignee FROM team_task WHERE id='task'").get()).toMatchObject({ assignee: "worker" })
  finish()
  await stopping
  expect(preserved).toEqual(["A", "B"])
  expect(deps.db.query("SELECT status FROM team_member WHERE name='worker'").get()).toMatchObject({ status: "shutdown" })
})

test("failed interrupt retains member execution and task ownership", async () => {
  const deps = setupDeps()
  insertTeam(deps.db, "t1", "test", "lead")
  insertMember(deps.db, "t1", "worker", "ses-worker", "busy")
  deps.client.session.execution = async () => "running"
  deps.client.session.abort = async () => { throw new Error("interrupt failed") }
  await expect(stopAndPreserveMember(deps, "t1", "worker", { force: true })).rejects.toThrow("interrupt failed")
  expect(deps.db.query("SELECT status FROM team_member WHERE name='worker'").get()).toMatchObject({ status: "busy" })
})
