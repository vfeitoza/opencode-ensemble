import type { Database } from "./db"
import type { PluginClient } from "./types"
import { randomUUID } from "node:crypto"
import { log } from "./log"

/** Persist an owned notification before fire-and-forget admission. */
export function queueTeamWake(client: PluginClient, db: Database, input: { teamId: string; messageId: string; sessionId: string; text: string }): void {
  const team = db.query("SELECT status FROM team WHERE id=?").get(input.teamId) as { status: string } | null
  if (team?.status !== "active" || db.query("SELECT team_id FROM team_notification_scope WHERE team_id=?").get(input.teamId)) return
  const previous = db.query("SELECT id,state FROM team_notification WHERE team_id=? AND message_id=? AND session_id=?").get(input.teamId, input.messageId, input.sessionId) as { id: string; state: string } | null
  if (previous && previous.state !== "failed") return
  const id = previous?.id ?? `msg_${randomUUID().replaceAll("-", "")}`
  if (!previous) db.run("INSERT INTO team_notification(id,team_id,message_id,session_id,state,time_created,time_updated) VALUES (?,?,?,?,'pending',?,?)", [id, input.teamId, input.messageId, input.sessionId, Date.now(), Date.now()])
  else db.run("UPDATE team_notification SET state='pending',time_updated=? WHERE id=?", [Date.now(), id])
  client.session.promptAsync({
    sessionID: input.sessionId,
    parts: [{ type: "text", text: input.text }],
    synthetic: true,
    notification: { teamId: input.teamId, messageId: input.messageId, inboxId: id },
  }).then(() => {
    db.run("UPDATE team_notification SET state=CASE WHEN state='cancel_requested' THEN state ELSE 'admitted' END,time_updated=? WHERE id=?", [Date.now(), id])
  }).catch(error => {
    db.run("UPDATE team_notification SET state=CASE WHEN state='cancel_requested' THEN state ELSE 'failed' END,time_updated=? WHERE id=?", [Date.now(), id])
    log(`notification:admission-failed id=${id} err=${error instanceof Error ? error.message : String(error)}`)
  })
}
