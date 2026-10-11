import { randomUUID } from "node:crypto"
import type { Database } from "./db"
import { withImmediateTransaction } from "./db"

/** Durable cleanup ownership, independent of the team's operational status. */
export interface CleanupOperation { teamId: string; id: string; revision: number }

/** Acquire ownership without stealing from a live or unverifiable process. */
export function beginCleanup(db: Database, teamId: string): CleanupOperation {
  return withImmediateTransaction(db, () => {
    const current = db.query("SELECT operation_id,owner_pid,revision FROM team_cleanup_state WHERE team_id=?").get(teamId) as { operation_id: string | null; owner_pid: number | null; revision: number } | null
    if (current?.operation_id) {
      let dead = false
      if (current.owner_pid) { try { process.kill(current.owner_pid, 0) } catch (error) { dead = !!error && typeof error === "object" && "code" in error && error.code === "ESRCH" } }
      if (!dead) throw new Error("Cleanup already in progress; live owner cannot be replaced")
    }
    const token = { teamId, id: randomUUID(), revision: (current?.revision ?? 0) + 1 }
    db.run("INSERT INTO team_cleanup_state(team_id,phase,operation_id,owner_pid,revision,time_updated) VALUES (?,'stopping',?,?,?,?) ON CONFLICT(team_id) DO UPDATE SET phase='stopping',operation_id=excluded.operation_id,owner_pid=excluded.owner_pid,revision=excluded.revision,last_error=NULL,time_updated=excluded.time_updated", [teamId, token.id, process.pid, token.revision, Date.now()])
    return token
  })
}

/** Advance the operation only if its CAS token still owns the team. */
export function advanceCleanup(db: Database, token: CleanupOperation, phase: "stopping" | "cancelling" | "removing"): void {
  if (db.run("UPDATE team_cleanup_state SET phase=?,time_updated=? WHERE team_id=? AND operation_id=? AND revision=?", [phase, Date.now(), token.teamId, token.id, token.revision]).changes !== 1) throw new Error("Cleanup ownership changed")
}

/** Retain a recoverable error and release only this operation's lease. */
export function blockCleanup(db: Database, token: CleanupOperation, error: unknown): void {
  db.run("UPDATE team_cleanup_state SET phase='blocked',operation_id=NULL,owner_pid=NULL,last_error=?,time_updated=? WHERE team_id=? AND operation_id=? AND revision=?", [error instanceof Error ? error.message : String(error), Date.now(), token.teamId, token.id, token.revision])
}

/** Complete only the matching owner, leaving unrelated operations intact. */
export function finishCleanup(db: Database, token: CleanupOperation): void {
  db.run("DELETE FROM team_cleanup_state WHERE team_id=? AND operation_id=? AND revision=?", [token.teamId, token.id, token.revision])
}

/** Refuse new work while cleanup is in progress or awaiting retry. */
export function assertTeamAcceptsWork(db: Database, teamId: string): void {
  if (db.query("SELECT team_id FROM team_cleanup_state WHERE team_id=?").get(teamId)) throw new Error("Team cleanup is pending; new work is blocked")
}

/** Serialize lifecycle tools across instances without holding a SQLite transaction over await. */
export async function withTeamOperation<T>(db: Database, teamIds: string[], action: () => Promise<T>): Promise<T> {
  const ids = [...new Set(teamIds)].sort()
  const owner = randomUUID()
  withImmediateTransaction(db, () => {
    for (const teamId of ids) {
      const admissions = db.query("SELECT id,owner_pid FROM team_spawn_admission WHERE team_id=?").all(teamId) as Array<{ id: string; owner_pid: number }>
      for (const admission of admissions) {
        let dead = false
        try { process.kill(admission.owner_pid, 0) } catch (error) { dead = !!error && typeof error === "object" && "code" in error && error.code === "ESRCH" }
        if (dead) db.run("DELETE FROM team_spawn_admission WHERE id=? AND owner_pid=?", [admission.id, admission.owner_pid])
      }
      if (db.query("SELECT id FROM team_spawn_admission WHERE team_id=? LIMIT 1").get(teamId)) throw new Error("Team has pending spawn admissions; lifecycle operation blocked")
      const current = db.query("SELECT operation_id,owner_pid FROM team_operation_lock WHERE team_id=?").get(teamId) as { operation_id: string; owner_pid: number } | null
      if (current) {
        let dead = false
        try { process.kill(current.owner_pid, 0) } catch (error) { dead = !!error && typeof error === "object" && "code" in error && error.code === "ESRCH" }
        if (!dead) throw new Error(`Another lifecycle operation owns team ${teamId}; retry when it finishes`)
        db.run("DELETE FROM team_operation_lock WHERE team_id=? AND operation_id=?", [teamId, current.operation_id])
      }
      db.run("INSERT INTO team_operation_lock(team_id,operation_id,owner_pid) VALUES(?,?,?)", [teamId, owner, process.pid])
    }
  })
  try { return await action() } finally {
    ids.forEach(teamId => { db.run("DELETE FROM team_operation_lock WHERE team_id=? AND operation_id=?", [teamId, owner]) })
  }
}

/** Concurrent spawns share admission; destructive operations require no admissions. */
export async function withSpawnAdmission<T>(db: Database, teamId: string, action: () => Promise<T>): Promise<T> {
  const id = randomUUID()
  withImmediateTransaction(db, () => {
    assertTeamAcceptsWork(db, teamId)
    if (db.query("SELECT team_id FROM team_operation_lock WHERE team_id=?").get(teamId)) throw new Error("Team lifecycle operation in progress; spawn blocked")
    db.run("INSERT INTO team_spawn_admission(id,team_id,owner_pid) VALUES(?,?,?)", [id, teamId, process.pid])
  })
  try { return await action() } finally { db.run("DELETE FROM team_spawn_admission WHERE id=?", [id]) }
}
