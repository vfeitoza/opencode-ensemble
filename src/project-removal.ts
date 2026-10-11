import { createHash, randomUUID } from "node:crypto"
import { withImmediateTransaction, type Database } from "./db"
import type { PluginClient } from "./types"
import type { MemberRegistry } from "./state"
import { cancelTeamNotifications } from "./notifications"
import { withTeamOperation } from "./team-cleanup-state"

/** Preview counts cover all retained history, not the dashboard's truncated feed. */
export interface ProjectRemovalPreview {
  project: { id: string; name: string; path: string }
  counts: { teams: number; members: number; tasks: number; messages: number; notifications: number; spawnResources: number }
  blockers: string[]
  token: string | null
}

/** An expected refusal is returned as an actionable HTTP error, not a server crash. */
export class ProjectRemovalError extends Error {
  constructor(public readonly status: number, message: string) { super(message); this.name = "ProjectRemovalError" }
}

interface Snapshot {
  project: ProjectRemovalPreview["project"]
  teams: Array<{ id: string; status: string }>
  teamIds: string[]
  members: Array<{ session_id: string; worktree_dir: string | null; worktree_branch: string | null; workspace_id: string | null }>
  counts: ProjectRemovalPreview["counts"]
  blockers: string[]
  fingerprint: string
}

function snapshot(db: Database, projectId: string, ignoreOperationLocks = false): Snapshot {
  const project = db.query("SELECT * FROM project WHERE id=?").get(projectId) as Snapshot["project"] | null
  if (!project) throw new ProjectRemovalError(404, "Project not found")
  const teams = db.query("SELECT * FROM team WHERE project_id=? ORDER BY id").all(projectId) as Snapshot["teams"]
  const history = db.query("SELECT team_id FROM team_project_history WHERE project_id=? ORDER BY team_id").all(projectId) as Array<{ team_id: string }>
  const teamIds = history.map(h => h.team_id)
  const rows = (table: string) => db.query(`SELECT * FROM ${table} WHERE team_id IN (SELECT team_id FROM team_project_history WHERE project_id=?) ORDER BY rowid`).all(projectId)
  const members = rows("team_member") as Snapshot["members"]
  const tasks = rows("team_task"), messages = rows("team_message")
  const notifications = rows("team_notification") as Array<{ state: string } & Record<string, unknown>>
  const spawn = rows("team_spawn_resource") as Array<{ state: string }>
  const cleanup = rows("team_cleanup_state"), admissions = rows("team_spawn_admission")
  const locks = ignoreOperationLocks ? [] : rows("team_operation_lock")
  const blockers = [
    ...(teams.some(t => t.status !== "archived") ? ["Archive active teams with team_cleanup before removing this project."] : []),
    ...(members.some(m => m.worktree_dir || m.worktree_branch || m.workspace_id) ? ["Worker resources or preserved branches remain. Safely merge/clean up/purge them first."] : []),
    ...(spawn.some(s => s.state !== "registered") ? ["Unresolved spawn resources require reconciliation before removal."] : []),
    ...(cleanup.length ? ["A team cleanup is incomplete; retry it before removal."] : []),
    ...(locks.length || admissions.length ? ["Lifecycle operations or prompt admissions are still pending."] : []),
    ...(notifications.some(n => n.state === "pending" || n.state === "cancel_requested") ? ["Notification delivery/cancellation is still pending; retain its recovery evidence."] : []),
  ]
  // Cancellation may only change these terminal delivery fields, not ownership.
  const notificationIdentity = notifications.map(({ state: _state, time_updated: _updated, ...n }) => n)
  const fingerprint = createHash("sha256").update(JSON.stringify([project, history, teams, members, tasks, messages, notificationIdentity, spawn, cleanup, admissions, rows("team_notification_scope")])).digest("hex")
  return { project, teams, teamIds, members, blockers, fingerprint, counts: { teams: teams.length, members: members.length, tasks: tasks.length, messages: messages.length, notifications: notifications.length, spawnResources: spawn.length } }
}

/** Delete only confirmed resource-free Ensemble history; never touch host files/sessions. */
export function createProjectRemoval(db: Database, options: { client?: PluginClient; registry?: MemberRegistry } = {}) {
  const confirmations = new Map<string, { projectId: string; fingerprint: string; expires: number }>()
  const executionBlockers = async (s: Snapshot): Promise<string[]> => {
    const sessions = [...new Set(s.members.map(m => m.session_id))]
    const results = await Promise.all(sessions.map(async sessionID => {
      try {
        const state = await options.client?.session.execution?.({ sessionID })
        return state === "idle" || state === "missing" ? null : `Worker ${sessionID} is running or its execution cannot be confirmed stopped.`
      } catch { return `Worker ${sessionID} execution check failed; removal blocked.` }
    }))
    return results.filter((r): r is string => r !== null)
  }
  return {
    preview: async (projectId: string): Promise<ProjectRemovalPreview> => {
      const s = snapshot(db, projectId)
      const blockers = [...s.blockers, ...await executionBlockers(s)]
      const unchanged = snapshot(db, projectId).fingerprint === s.fingerprint
      if (!unchanged) blockers.push("Project changed while checking it; refresh the preview.")
      confirmations.forEach((value, token) => { if (value.expires <= Date.now() || value.projectId === projectId) confirmations.delete(token) })
      const token = blockers.length ? null : randomUUID()
      if (token) {
        const oldest = confirmations.keys().next().value
        if (confirmations.size >= 128 && oldest) confirmations.delete(oldest)
        confirmations.set(token, { projectId, fingerprint: s.fingerprint, expires: Date.now() + 120_000 })
      }
      return { project: { id: s.project.id, name: s.project.name, path: s.project.path }, counts: s.counts, blockers, token }
    },
    remove: async (projectId: string, input: { token: string; name: string }): Promise<{ removed: true }> => {
      const confirmation = confirmations.get(input.token)
      confirmations.delete(input.token)
      if (!confirmation || confirmation.projectId !== projectId || confirmation.expires <= Date.now()) throw new ProjectRemovalError(409, "Confirmation expired or already used; refresh the preview.")
      const initial = snapshot(db, projectId)
      if (input.name !== initial.project.name) throw new ProjectRemovalError(400, "Type the exact project name to confirm removal.")
      if (confirmation.fingerprint !== initial.fingerprint || initial.blockers.length) throw new ProjectRemovalError(409, "Project changed or has pending work; refresh the preview.")
      const teamIds = initial.teamIds
      return withTeamOperation(db, teamIds, async () => {
        const blocked = await executionBlockers(initial)
        if (blocked.length) throw new ProjectRemovalError(409, blocked.join(" "))
        if (initial.counts.notifications) {
          if (!options.client) throw new ProjectRemovalError(409, "Inbox cancellation unavailable; removal blocked.")
          for (const teamId of teamIds) await cancelTeamNotifications(options.client, db, teamId)
        }
        // Recheck host execution after inbox awaits; all new DB data is checked below.
        const finalBlocked = await executionBlockers(initial)
        if (finalBlocked.length) throw new ProjectRemovalError(409, finalBlocked.join(" "))
        withImmediateTransaction(db, () => {
          const current = snapshot(db, projectId, true)
          if (current.fingerprint !== confirmation.fingerprint || current.blockers.length) throw new ProjectRemovalError(409, "Project changed during removal; nothing was deleted. Refresh the preview.")
          const tables = ["team_notification", "team_notification_scope", "team_spawn_resource", "team_cleanup_state", "team_spawn_admission"]
          tables.forEach(table => { db.run(`DELETE FROM ${table} WHERE team_id IN (SELECT team_id FROM team_project_history WHERE project_id=?)`, [projectId]) })
          db.run("DELETE FROM project WHERE id=?", [projectId])
        })
        teamIds.forEach(id => { options.registry?.unregisterTeam(id) })
        return { removed: true }
      })
    },
  }
}
