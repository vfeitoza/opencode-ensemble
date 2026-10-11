import type { Database } from "./db"
import type { ToolDeps } from "./types"
import { access } from "node:fs/promises"
import { runCommand } from "./process"
import { getTeamResourceParts, preservedBranchName, type PreserveBranchFn } from "./tools/merge-helper"
import { verifyWorktreeIdentity, type WorktreeIdentity } from "./v2-worktree"
import { realpath } from "node:fs/promises"

/** Preserve a member's latest committed work before destructive lifecycle actions. */
export async function preserveMemberHead(
  db: Database, teamId: string, memberName: string, cwd: string,
  options: { allowDirty?: boolean; preserve?: PreserveBranchFn } = {},
): Promise<string | null> {
  const member = db.query("SELECT worktree_dir,worktree_branch,worktree_identity FROM team_member WHERE team_id=? AND name=?").get(teamId, memberName) as { worktree_dir: string | null; worktree_branch: string | null; worktree_identity: string | null } | null
  if (!member) throw new Error(`Member not found: ${memberName}`)
  if (!member.worktree_dir && !member.worktree_branch) return null
  const resource = getTeamResourceParts(db, teamId)
  const target = preservedBranchName(resource.projectName, resource.teamName, resource.teamId, memberName)
  // Custom ref-preservation backend, supplied by callers that own its contract.
  if (options.preserve) {
    if (!member.worktree_branch || !await options.preserve(member.worktree_branch, target, cwd)) throw new Error(`Failed to preserve ${memberName}; abort/remove blocked`)
    db.run("UPDATE team_member SET worktree_branch=? WHERE team_id=? AND name=?", [target, teamId, memberName])
    return target
  }
  const git = async (directory: string, args: string[]): Promise<string> => {
    const result = await runCommand(["git", ...args], { cwd: directory })
    if (result.exitCode !== 0) throw new Error(`Failed to preserve ${memberName}: ${result.stderr.trim()}`)
    return result.stdout.trim()
  }
  let directoryExists = false
  if (member.worktree_dir) {
    try { await access(member.worktree_dir); directoryExists = true } catch { /* a removed checkout may still have its owned ref */ }
  }
  const checkout = directoryExists ? member.worktree_dir : null
  const identity = member.worktree_identity ? JSON.parse(member.worktree_identity) as WorktreeIdentity : null
  if (checkout) {
    if (!identity) throw new Error(`Worktree identity missing for legacy member ${memberName}; preservation/removal blocked`)
    await verifyWorktreeIdentity(checkout, identity)
    const leadCommon = await realpath(await git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]))
    if (leadCommon !== identity.commonDir) throw new Error("Preservation repository identity mismatch")
  } else if (identity) {
    const leadCommon = await realpath(await git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]))
    if (leadCommon !== identity.commonDir) throw new Error("Preservation repository identity mismatch")
  }
  if (checkout && !options.allowDirty && await git(checkout, ["status", "--porcelain"])) {
    throw new Error(`Member ${memberName} has uncommitted work at ${member.worktree_dir}; abort/remove blocked`)
  }
  const source = checkout
    ? await git(checkout, ["rev-parse", "--verify", "HEAD^{commit}"])
    : member.worktree_branch ? await git(cwd, ["rev-parse", "--verify", `${member.worktree_branch}^{commit}`]) : null
  if (!source) throw new Error(`No owned commit for ${memberName}; abort/remove blocked`)
  const existing = await runCommand(["git", "show-ref", "--verify", "--hash", `refs/heads/${target}`], { cwd })
  const old = existing.exitCode === 0 ? existing.stdout.trim() : ""
  if (old && member.worktree_branch !== target) throw new Error(`Preserved ref collision for ${memberName}`)
  if (old && old !== source) {
    const ancestor = await runCommand(["git", "merge-base", "--is-ancestor", old, source], { cwd })
    if (ancestor.exitCode !== 0) throw new Error(`Preserved ref diverged for ${memberName}; abort/remove blocked`)
  }
  await git(cwd, ["update-ref", `refs/heads/${target}`, source, old || "0000000000000000000000000000000000000000"])
  if (await git(cwd, ["rev-parse", "--verify", `refs/heads/${target}`]) !== source) throw new Error(`Preservation verification failed for ${memberName}`)
  db.run("UPDATE team_member SET worktree_branch=? WHERE team_id=? AND name=?", [target, teamId, memberName])
  return target
}

/** Use the configured preservation backend, or the verified local Git implementation. */
export function preserveMemberWork(deps: ToolDeps, teamId: string, memberName: string, allowDirty = false): Promise<string | null> {
  return deps.preserveMember
    ? deps.preserveMember(teamId, memberName, allowDirty)
    : preserveMemberHead(deps.db, teamId, memberName, deps.directory, { allowDirty })
}
