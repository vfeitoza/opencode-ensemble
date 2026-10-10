import type { Database } from "./db"
import type { PluginClient } from "./types"
import { randomUUID } from "node:crypto"
import { log } from "./log"

/** Persist an owned notification before fire-and-forget admission. */
export function queueTeamWake(client: PluginClient, db: Database, input: { teamId: string; messageId: string; sessionId: string; text: string }): void {
  const team = db.query("SELECT status FROM team WHERE id=?").get(input.teamId) as { status: string } | null
  if (team?.status !== "active" || db.query("SELECT team_id FROM team_notification_scope WHERE team_id=?").get(input.teamId)) return
  if (client.session.notificationMode === "legacy") {
    client.session.promptAsync({ sessionID: input.sessionId, parts: [{ type: "text", text: input.text }], synthetic: true }).catch(error => log(`notification:legacy-failed err=${String(error)}`))
    return
  }
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
    const closed = db.query("SELECT team_id FROM team_notification_scope WHERE team_id=?").get(input.teamId)
    db.run("UPDATE team_notification SET state=?,time_updated=? WHERE id=?", [closed ? "cancel_requested" : "admitted", Date.now(), id])
    if (closed && client.session.inbox) void cancelTeamNotifications(client, db, input.teamId).catch(error => log(`notification:late-cancel-failed id=${id} err=${String(error)}`))
  }).catch(error => {
    db.run("UPDATE team_notification SET state=CASE WHEN state='cancel_requested' THEN state ELSE 'failed' END,time_updated=? WHERE id=?", [Date.now(), id])
    log(`notification:admission-failed id=${id} err=${error instanceof Error ? error.message : String(error)}`)
  })
}

/** Close admission for a team before cancelling its queued notifications. */
export function closeTeamNotifications(db: Database, teamId: string): void {
  db.run("INSERT OR IGNORE INTO team_notification_scope(team_id,closed_at) VALUES (?,?)", [teamId, Date.now()])
  db.run("UPDATE team_notification SET state='cancel_requested',time_updated=? WHERE team_id=? AND state!='cancelled'", [Date.now(), teamId])
}

/** Cancel only notifications proven to belong to the specified Ensemble team. */
export async function cancelTeamNotifications(client: PluginClient, db: Database, teamId: string): Promise<{ cancelled: number; ambiguous: number }> {
  // Recheck even previously absent/cancelled IDs in a closed scope: an old host
  // admission can arrive after process reload, without its original callback.
  const records = db.query("SELECT id,session_id FROM team_notification WHERE team_id=?").all(teamId) as Array<{ id: string; session_id: string }>
  if (!records.length) return { cancelled: 0, ambiguous: 0 }
  if (!client.session.inbox) throw new Error(`Inbox cancellation unavailable for team ${teamId}; purge blocked`)
  let cancelled = 0
  for (const sessionID of new Set(records.map(record => record.session_id))) {
    const items = (await client.session.inbox.list({ sessionID })).data ?? []
    for (const item of items) {
      const owned = item.metadata?.ensemble as { teamId?: string; notificationId?: string; messageId?: string } | undefined
      if (item.type === "synthetic" && owned?.teamId === teamId && owned.notificationId === item.id && !records.some(record => record.id === item.id)) {
        db.run("INSERT OR IGNORE INTO team_notification(id,team_id,message_id,session_id,state,time_created,time_updated) VALUES (?,?,?,?,'cancel_requested',?,?)", [item.id, teamId, owned.messageId ?? item.id, sessionID, Date.now(), Date.now()])
        records.push({ id: item.id, session_id: sessionID })
      }
    }
    for (const record of records.filter(record => record.session_id === sessionID)) {
      const item = items.find(entry => entry.id === record.id)
      if (item) {
        if (item.type !== "synthetic") throw new Error(`Notification ownership conflict for ${record.id}; refusing to cancel user input`)
        try { await client.session.inbox.cancel({ sessionID, inboxID: record.id }) } catch (error) {
          const current = (await client.session.inbox.list({ sessionID })).data ?? []
          if (current.some(entry => entry.id === record.id)) throw error
        }
      }
      db.run("UPDATE team_notification SET state='cancelled',time_updated=? WHERE id=?", [Date.now(), record.id])
      cancelled += 1
    }
  }
  return { cancelled, ambiguous: 0 }
}

/** Report legacy notification-looking items without treating text as ownership. */
export async function countAmbiguousNotifications(client: PluginClient, db: Database, teamId: string): Promise<number> {
  if (!client.session.inbox) return 0
  const team = db.query("SELECT lead_session_id FROM team WHERE id=?").get(teamId) as { lead_session_id: string } | null
  if (!team) return 0
  const members = db.query("SELECT session_id FROM team_member WHERE team_id=?").all(teamId) as Array<{ session_id: string }>
  let ambiguous = 0
  for (const sessionID of new Set([team.lead_session_id, ...members.map(member => member.session_id)])) {
    const items = (await client.session.inbox.list({ sessionID })).data ?? []
    ambiguous += items.filter(item => item.type === "synthetic" && item.payload?.text?.startsWith("[System: New team message from ") && !db.query("SELECT id FROM team_notification WHERE id=? AND team_id=?").get(item.id, teamId)).length
  }
  return ambiguous
}

/** Retry durable cancellation records on reload, without issuing new reminders. */
export async function reconcileNotifications(client: PluginClient, db: Database): Promise<void> {
  const scopes = db.query("SELECT team_id FROM team_notification_scope").all() as Array<{ team_id: string }>
  for (const scope of scopes) await cancelTeamNotifications(client, db, scope.team_id)
}
