import { expect, test } from "bun:test"
import { setupDeps, insertTeam, insertMember } from "./helpers"
import { createProjectRemoval } from "../src/project-removal"

function fixture() {
  const deps = setupDeps()
  insertTeam(deps.db, "team", "old", "lead", "archived")
  insertMember(deps.db, "team", "worker", "session", "shutdown")
  deps.registry.register("team", "worker", "session")
  deps.db.run("INSERT INTO team_task(id,team_id,content,status,priority,time_created,time_updated) VALUES('task','team','work','completed','medium',0,0)")
  deps.db.run("INSERT INTO team_message(id,team_id,from_name,content,time_created) VALUES('message','team','worker','done',0)")
  deps.db.run("INSERT INTO team_spawn_resource(id,team_id,member_name,state,time_created,time_updated) VALUES('spawn','team','worker','registered',0,0)")
  deps.db.run("INSERT INTO team_notification(id,team_id,message_id,session_id,state,time_created,time_updated) VALUES('owned','team','message','lead','cancelled',0,0)")
  deps.db.run("INSERT INTO team_notification_scope(team_id,closed_at) VALUES('team',0)")
  return { deps, service: createProjectRemoval(deps.db, deps), projectId: "/tmp/test-project" }
}

test("removes all project history and auxiliary rows without touching another project or host resources", async () => {
  const { deps, service, projectId } = fixture()
  deps.db.run("INSERT INTO project(id,name,path,status,time_created,time_updated) VALUES('other','other','/other','active',0,0)")
  deps.db.run("INSERT INTO team(id,name,project_id,lead_session_id,time_created,time_updated) VALUES('other-team','other','other','other-lead',0,0)")
  const preview = await service.preview(projectId)
  expect(preview.counts).toEqual({ teams: 1, members: 1, tasks: 1, messages: 1, notifications: 1, spawnResources: 1 })
  expect(preview.blockers).toEqual([])
  await service.remove(projectId, { token: preview.token!, name: "test-project" })
  for (const table of ["team", "team_member", "team_task", "team_message", "team_notification", "team_notification_scope", "team_spawn_resource", "team_cleanup_state", "team_spawn_admission", "team_operation_lock"]) {
    expect(deps.db.query(`SELECT * FROM ${table}${table === "team" ? " WHERE id='team'" : " WHERE team_id='team'"}`).all()).toEqual([])
  }
  expect(deps.db.query("SELECT id FROM project WHERE id=?").get(projectId)).toBeNull()
  expect(deps.db.query("SELECT id FROM team WHERE id='other-team'").get()).toBeTruthy()
  expect(deps.registry.getBySession("session")).toBeUndefined()
  expect(deps.client.calls.some(c => ["session.abort", "worktree.remove", "workspace.remove"].includes(c.method))).toBe(false)
  deps.db.close()
})

test("active teams, unknown/running execution and outstanding recovery records block deletion", async () => {
  const cases = [
    "UPDATE team SET status='active' WHERE id='team'",
    "UPDATE team_member SET worktree_dir='/owned' WHERE team_id='team'",
    "UPDATE team_member SET worktree_branch='owned' WHERE team_id='team'",
    "UPDATE team_member SET workspace_id='owned' WHERE team_id='team'",
    "UPDATE team_spawn_resource SET state='timed_out' WHERE id='spawn'",
    "UPDATE team_notification SET state='pending' WHERE id='owned'",
    "INSERT INTO team_cleanup_state(team_id,phase,time_updated) VALUES('team','blocked',0)",
    "INSERT INTO team_operation_lock(team_id,operation_id,owner_pid) VALUES('team','other',1)",
    "INSERT INTO team_spawn_admission(id,team_id,owner_pid) VALUES('pending','team',1)",
  ]
  for (const sql of cases) {
    const { deps, service, projectId } = fixture()
    deps.db.run(sql)
    const preview = await service.preview(projectId)
    expect(preview.blockers.length).toBeGreaterThan(0)
    expect(preview.token).toBeNull()
    deps.db.close()
  }
  for (const execution of ["running", "unknown"] as const) {
    const { deps, service, projectId } = fixture()
    deps.client.session.execution = async () => execution
    expect((await service.preview(projectId)).token).toBeNull()
    deps.db.close()
  }
})

test("wrong name, reused token, changed data and concurrent new team never delete the target", async () => {
  const { deps, service, projectId } = fixture()
  const p = await service.preview(projectId)
  await expect(service.remove(projectId, { token: p.token!, name: "wrong" })).rejects.toThrow()
  const next = await service.preview(projectId)
  deps.db.run("INSERT INTO team_message(id,team_id,from_name,content,time_created) VALUES('late','team','worker','later',1)")
  await expect(service.remove(projectId, { token: next.token!, name: "test-project" })).rejects.toThrow()
  expect(deps.db.query("SELECT id FROM project WHERE id=?").get(projectId)).toBeTruthy()
  const fresh = await service.preview(projectId)
  let release: () => void = () => undefined
  let entered: () => void = () => undefined
  const gate = new Promise<void>(resolve => { entered = resolve })
  let first = true
  deps.client.session.execution = async () => { if (first) { first = false; entered(); await new Promise<void>(resolve => { release = resolve }) }; return "idle" }
  const deleting = service.remove(projectId, { token: fresh.token!, name: "test-project" })
  await gate
  deps.db.run("INSERT INTO team(id,name,project_id,lead_session_id,time_created,time_updated) VALUES('late-team','late',?,'late-lead',0,0)", [projectId])
  release()
  await expect(deleting).rejects.toThrow()
  await expect(service.remove(projectId, { token: fresh.token!, name: "test-project" })).rejects.toThrow()
  expect(deps.db.query("SELECT id FROM team WHERE id='late-team'").get()).toBeTruthy()
  deps.db.close()
})

test("inbox fault preserves data and foreign-key failure rolls back the whole deletion", async () => {
  const { deps, service, projectId } = fixture()
  const preview = await service.preview(projectId)
  deps.client.session.inbox!.list = async () => { throw new Error("inbox offline") }
  await expect(service.remove(projectId, { token: preview.token!, name: "test-project" })).rejects.toThrow("inbox offline")
  expect(deps.db.query("SELECT id FROM team WHERE id='team'").get()).toBeTruthy()
  deps.client.session.inbox!.list = async () => ({ data: [] })
  deps.db.run("CREATE TRIGGER reject_project BEFORE DELETE ON project BEGIN SELECT RAISE(ABORT,'reject deletion'); END")
  const next = await service.preview(projectId)
  await expect(service.remove(projectId, { token: next.token!, name: "test-project" })).rejects.toThrow("reject deletion")
  expect(deps.db.query("SELECT id FROM team_message WHERE id='message'").get()).toBeTruthy()
  expect(deps.db.query("SELECT id FROM team_notification WHERE id='owned'").get()).toBeTruthy()
  deps.db.close()
})

test("project removal includes terminal notification history left by a previously purged team", async () => {
  const { deps, service, projectId } = fixture()
  deps.db.run("DELETE FROM team_spawn_resource WHERE team_id='team'")
  deps.db.run("DELETE FROM team WHERE id='team'")
  const preview = await service.preview(projectId)
  expect(preview.counts.notifications).toBe(1)
  await service.remove(projectId, { token: preview.token!, name: "test-project" })
  expect(deps.db.query("SELECT id FROM team_notification WHERE team_id='team'").all()).toEqual([])
  expect(deps.db.query("SELECT team_id FROM team_notification_scope WHERE team_id='team'").all()).toEqual([])
  deps.db.close()
})
