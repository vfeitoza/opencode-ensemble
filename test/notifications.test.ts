import { describe, expect, test } from "bun:test"
import { setupDeps, insertTeam } from "./helpers"
import { queueTeamWake, closeTeamNotifications, cancelTeamNotifications, countAmbiguousNotifications, reconcileNotifications } from "../src/notifications"

describe("owned team notifications", () => {
  test("removed lead session does not block legacy preview counting", async () => {
    const deps = setupDeps()
    insertTeam(deps.db, "t1", "team", "gone-session")
    deps.client.session.inbox = { list: async () => { throw { _tag: "SessionNotFoundError", sessionID: "gone-session" } }, cancel: async () => undefined }
    expect(await countAmbiguousNotifications(deps.client, deps.db, "t1")).toBe(0)
  })

  test("a failing scope does not prevent cancellation for a second team", async () => {
    const deps = setupDeps()
    const ids: Record<string, string> = {}
    for (const id of ["a", "b"]) {
      insertTeam(deps.db, id, id, `lead-${id}`)
      queueTeamWake(deps.client, deps.db, { teamId: id, messageId: id, sessionId: `lead-${id}`, text: "wake" })
      closeTeamNotifications(deps.db, id)
      ids[id] = (deps.db.query("SELECT id FROM team_notification WHERE team_id=?").get(id) as { id: string }).id
    }
    await Promise.resolve()
    const cancelled: string[] = []
    deps.client.session.inbox = {
      list: async ({ sessionID }) => { if (sessionID === "lead-a") throw new Error("transport unavailable"); return { data: [{ id: ids.b!, type: "synthetic" }] } },
      cancel: async ({ inboxID }) => { cancelled.push(inboxID) },
    }
    try { await reconcileNotifications(deps.client, deps.db) } catch { /* baseline throws before trying b */ }
    expect(cancelled).toContain(ids.b!)
  })
  test("reload reconciliation rechecks a previously absent ID that the host admits late", async () => {
    const deps = setupDeps()
    insertTeam(deps.db, "team1", "team", "lead")
    deps.client.session.promptAsync = () => new Promise(() => {})
    queueTeamWake(deps.client, deps.db, { teamId: "team1", messageId: "message1", sessionId: "lead", text: "wake" })
    const row = deps.db.query("SELECT id FROM team_notification").get() as { id: string }
    closeTeamNotifications(deps.db, "team1")
    await cancelTeamNotifications(deps.client, deps.db, "team1")
    const queued = [{ id: row.id, type: "synthetic" }]
    deps.client.session.inbox = { list: async () => ({ data: [...queued] }), cancel: async () => { queued.length = 0 } }
    await reconcileNotifications(deps.client, deps.db)
    expect(queued).toEqual([])
  })
  test("legacy V1 notification delivery does not create queued-inbox cancellation requirements", async () => {
    const deps = setupDeps()
    deps.client.session.notificationMode = "legacy"
    deps.client.session.inbox = undefined
    insertTeam(deps.db, "team1", "team", "lead")
    queueTeamWake(deps.client, deps.db, { teamId: "team1", messageId: "message1", sessionId: "lead", text: "hello" })
    closeTeamNotifications(deps.db, "team1")
    expect(await cancelTeamNotifications(deps.client, deps.db, "team1")).toEqual({ cancelled: 0, ambiguous: 0 })
    expect(deps.client.calls.filter(call => call.method === "session.promptAsync")).toHaveLength(1)
  })
  test("legacy text is reported as ambiguous, never cancelled as ownership proof", async () => {
    const deps = setupDeps()
    insertTeam(deps.db, "team1", "team", "lead")
    let cancellations = 0
    deps.client.session.inbox = { list: async () => ({ data: [{ id: "msg_legacy", type: "synthetic", payload: { text: "[System: New team message from worker]" } }, { id: "msg_user", type: "user", payload: { text: "[System: New team message from worker]" } }] }), cancel: async () => { cancellations += 1 } }
    expect(await countAmbiguousNotifications(deps.client, deps.db, "team1")).toBe(1)
    closeTeamNotifications(deps.db, "team1")
    expect(await cancelTeamNotifications(deps.client, deps.db, "team1")).toMatchObject({ cancelled: 0 })
    expect(cancellations).toBe(0)
  })
  test("close cancels owned inbox items while leaving user and foreign-team entries untouched", async () => {
    const deps = setupDeps()
    insertTeam(deps.db, "team1", "team", "lead")
    queueTeamWake(deps.client, deps.db, { teamId: "team1", messageId: "message1", sessionId: "lead", text: "hello" })
    await new Promise(resolve => setTimeout(resolve, 0))
    const owned = deps.db.query("SELECT id FROM team_notification").get() as { id: string }
    const cancelled: string[] = []
    deps.client.session.inbox = {
      list: async () => ({ data: [{ id: owned.id, type: "synthetic" }, { id: "msg_user", type: "user" }, { id: "msg_foreign", type: "synthetic", metadata: { ensemble: { teamId: "other" } } }] }),
      cancel: async ({ inboxID }) => { cancelled.push(inboxID) },
    }
    closeTeamNotifications(deps.db, "team1")
    expect(await cancelTeamNotifications(deps.client, deps.db, "team1")).toEqual({ cancelled: 1, ambiguous: 0 })
    expect(cancelled).toEqual([owned.id])
  })

  test("close during pending admission leaves cancellation evidence and prevents new wakes", async () => {
    const deps = setupDeps()
    deps.client.session.inbox = undefined
    insertTeam(deps.db, "team1", "team", "lead")
    let resolveDelivery: () => void = () => undefined
    deps.client.session.promptAsync = () => new Promise(resolve => { resolveDelivery = () => resolve({}) })
    queueTeamWake(deps.client, deps.db, { teamId: "team1", messageId: "message1", sessionId: "lead", text: "hello" })
    closeTeamNotifications(deps.db, "team1")
    resolveDelivery()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(deps.db.query("SELECT state FROM team_notification").get()).toMatchObject({ state: "cancel_requested" })
    queueTeamWake(deps.client, deps.db, { teamId: "team1", messageId: "message2", sessionId: "lead", text: "hello" })
    expect(deps.db.query("SELECT id FROM team_notification").all()).toHaveLength(1)
  })

  test("admission arriving after close is cancelled rather than surviving purge", async () => {
    const deps = setupDeps()
    insertTeam(deps.db, "team1", "team", "lead")
    let finish: () => void = () => undefined
    const queued: Array<{ id: string; type: string }> = []
    deps.client.session.promptAsync = options => new Promise(resolve => {
      finish = () => { queued.push({ id: options.notification!.inboxId, type: "synthetic" }); resolve({}) }
    })
    deps.client.session.inbox = {
      list: async () => ({ data: [...queued] }),
      cancel: async ({ inboxID }) => { queued.splice(queued.findIndex(item => item.id === inboxID), 1) },
    }
    queueTeamWake(deps.client, deps.db, { teamId: "team1", messageId: "message1", sessionId: "lead", text: "hello" })
    closeTeamNotifications(deps.db, "team1")
    await cancelTeamNotifications(deps.client, deps.db, "team1")
    deps.db.run("DELETE FROM team WHERE id='team1'")
    finish()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(queued).toEqual([])
    expect(deps.db.query("SELECT state FROM team_notification").get()).toMatchObject({ state: "cancelled" })
  })

  test("cancellation failure keeps durable evidence instead of declaring purge complete", async () => {
    const deps = setupDeps()
    insertTeam(deps.db, "team1", "team", "lead")
    queueTeamWake(deps.client, deps.db, { teamId: "team1", messageId: "message1", sessionId: "lead", text: "hello" })
    await new Promise(resolve => setTimeout(resolve, 0))
    const owned = deps.db.query("SELECT id FROM team_notification").get() as { id: string }
    deps.client.session.inbox = { list: async () => ({ data: [{ id: owned.id, type: "synthetic" }] }), cancel: async () => { throw new Error("HTTP 500") } }
    closeTeamNotifications(deps.db, "team1")
    await expect(cancelTeamNotifications(deps.client, deps.db, "team1")).rejects.toThrow("HTTP 500")
    expect(deps.db.query("SELECT state FROM team_notification").get()).toMatchObject({ state: "cancel_requested" })
  })
  test("persists ownership before admission without awaiting a hanging transport", () => {
    const deps = setupDeps()
    insertTeam(deps.db, "team1", "team", "lead")
    let observed: unknown
    deps.client.session.promptAsync = options => {
      observed = options
      expect(deps.db.query("SELECT team_id,message_id,session_id,state FROM team_notification").get()).toMatchObject({ team_id: "team1", message_id: "message1", session_id: "lead", state: "pending" })
      return new Promise(() => {})
    }
    queueTeamWake(deps.client, deps.db, { teamId: "team1", messageId: "message1", sessionId: "lead", text: "hello" })
    expect(observed).toMatchObject({ synthetic: true, notification: { teamId: "team1", messageId: "message1" } })
    expect((observed as { notification: { inboxId: string } }).notification.inboxId).toMatch(/^msg_/)
  })

  test("deduplicates the logical wake while admission is pending", () => {
    const deps = setupDeps()
    insertTeam(deps.db, "team1", "team", "lead")
    deps.client.session.promptAsync = options => {
      deps.client.calls.push({ method: "session.promptAsync", args: [options] })
      return new Promise(() => {})
    }
    const input = { teamId: "team1", messageId: "message1", sessionId: "lead", text: "hello" }
    queueTeamWake(deps.client, deps.db, input)
    queueTeamWake(deps.client, deps.db, input)
    expect(deps.client.calls).toHaveLength(1)
  })

  test("notification evidence survives purge cascade and admission errors", async () => {
    const deps = setupDeps()
    insertTeam(deps.db, "team1", "team", "lead")
    deps.client.session.promptAsync = async () => { throw new Error("transport down") }
    queueTeamWake(deps.client, deps.db, { teamId: "team1", messageId: "message1", sessionId: "lead", text: "hello" })
    await new Promise(resolve => setTimeout(resolve, 0))
    deps.db.run("DELETE FROM team WHERE id='team1'")
    expect(deps.db.query("SELECT state FROM team_notification").get()).toMatchObject({ state: "failed" })
  })
})
