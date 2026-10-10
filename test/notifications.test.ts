import { describe, expect, test } from "bun:test"
import { setupDeps, insertTeam } from "./helpers"
import { queueTeamWake } from "../src/notifications"

describe("owned team notifications", () => {
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
