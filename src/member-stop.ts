import type { ToolDeps } from "./types"
import { preserveMemberWork } from "./member-preservation"
import { releaseMemberTasks } from "./tasks"

/** Require an authoritative execution state, never infer idle from a missing capability. */
export async function memberExecution(deps: ToolDeps, sessionID: string): Promise<"running" | "idle" | "missing" | "unknown"> {
  if (!deps.client.session.execution) return "unknown"
  try { return await deps.client.session.execution({ sessionID }) } catch { return "unknown" }
}

/** Preserve before interrupt and again after confirmed idle; failures retain task ownership. */
export async function stopAndPreserveMember(deps: ToolDeps, teamId: string, memberName: string, options: { force: boolean }): Promise<{ ref: string | null; execution: "idle" | "missing" }> {
  const row = deps.db.query("SELECT session_id,status FROM team_member WHERE team_id=? AND name=?").get(teamId, memberName) as { session_id: string; status: string } | null
  if (!row) throw new Error(`Member not found: ${memberName}`)
  let execution = await memberExecution(deps, row.session_id)
  if (execution === "unknown") throw new Error(`Execution of ${memberName} is unknown; cleanup blocked`)
  if (execution === "running") {
    if (!options.force || !deps.client.session.nonDestructiveInterrupt) throw new Error(`Member ${memberName} is still active; wait for confirmed shutdown before cleanup`)
    await preserveMemberWork(deps, teamId, memberName)
    await deps.client.session.abort({ sessionID: row.session_id })
    execution = await memberExecution(deps, row.session_id)
    if (execution !== "idle" && execution !== "missing") throw new Error(`Member ${memberName} has not stopped; cleanup blocked`)
  }
  const ref = await preserveMemberWork(deps, teamId, memberName)
  deps.db.run("UPDATE team_member SET status='shutdown',execution_status='idle',time_updated=? WHERE team_id=? AND name=?", [Date.now(), teamId, memberName])
  releaseMemberTasks(deps.db, teamId, memberName)
  return { ref, execution }
}
