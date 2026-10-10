import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { runCommand } from "../src/process"
import { preserveMemberHead } from "../src/member-preservation"
import { setupDeps, insertTeam, insertMember } from "./helpers"
import { executeTeamShutdown } from "../src/tools/team-shutdown"
import { executeTeamMerge } from "../src/tools/team-merge"

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await runCommand(["git", ...args], { cwd })
  if (result.exitCode !== 0) throw new Error(result.stderr)
  return result.stdout.trim()
}

describe("final member HEAD preservation", () => {
  test("refreshes preserved ref after a commit during graceful shutdown", async () => {
    const root = await mkdtemp("/tmp/opencode/member-preserve-")
    const deps = setupDeps()
    insertTeam(deps.db, "team1", "preserve-team", "lead")
    insertMember(deps.db, "team1", "worker", "ses-worker")
    try {
      await git(root, "init")
      await git(root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "base")
      const directory = path.join(root, "worker")
      await git(root, "worktree", "add", "-b", "ensemble-worker", directory)
      deps.db.run("UPDATE team_member SET worktree_dir=?,worktree_branch='ensemble-worker' WHERE team_id='team1'", [directory])
      const ref = await preserveMemberHead(deps.db, "team1", "worker", root)
      expect(ref).toContain("ensemble/preserved/")
      await git(directory, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "last commit")
      expect(await preserveMemberHead(deps.db, "team1", "worker", root)).toBe(ref)
      expect(await git(root, "rev-parse", ref!)).toBe(await git(directory, "rev-parse", "HEAD"))
      deps.directory = root
      deps.registry.register("team1", "worker", "ses-worker")
      await Bun.write(path.join(directory, "agent.txt"), "agent work")
      await git(directory, "add", "agent.txt")
      await git(directory, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "agent work")
      await executeTeamShutdown(deps, { member: "worker", force: true }, "lead")
      expect(deps.client.calls.filter(c => c.method === "session.abort")).toHaveLength(1)
      await executeTeamMerge(deps, { member: "worker" }, "lead")
      expect(await Bun.file(path.join(root, "agent.txt")).text()).toBe("agent work")
      deps.db.run("UPDATE team_member SET worktree_branch=? WHERE team_id='team1'", [ref])
      await Bun.write(path.join(directory, "dirty.txt"), "uncommitted")
      await expect(preserveMemberHead(deps.db, "team1", "worker", root)).rejects.toThrow("uncommitted")
    } finally { deps.db.close(); await rm(root, { recursive: true, force: true }) }
  })

  test("unresolvable member ref fails closed while shared member needs no preservation", async () => {
    const deps = setupDeps()
    insertTeam(deps.db, "team1", "preserve-team", "lead")
    insertMember(deps.db, "team1", "worker", "ses-worker")
    expect(await preserveMemberHead(deps.db, "team1", "worker", "/tmp/opencode")).toBeNull()
    deps.db.run("UPDATE team_member SET worktree_branch='missing-ref' WHERE team_id='team1'")
    await expect(preserveMemberHead(deps.db, "team1", "worker", "/tmp/opencode")).rejects.toThrow()
  })
})
