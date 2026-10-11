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
