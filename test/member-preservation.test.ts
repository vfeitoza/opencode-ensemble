import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, mkdir } from "node:fs/promises"
import path from "node:path"
import { runCommand } from "../src/process"
import { preserveMemberHead } from "../src/member-preservation"
import { setupDeps, insertTeam, insertMember } from "./helpers"
import { executeTeamShutdown } from "../src/tools/team-shutdown"
import { executeTeamMerge } from "../src/tools/team-merge"
import { inspectWorktreeIdentity } from "../src/v2-worktree"

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await runCommand(["git", ...args], { cwd })
  if (result.exitCode !== 0) throw new Error(result.stderr)
  return result.stdout.trim()
}

describe("final member HEAD preservation", () => {
  test("rejects replaced checkout identity instead of preserving the ancestor repository HEAD", async () => {
    const root = await mkdtemp("/tmp/opencode/replaced-worktree-")
    const deps = setupDeps()
    insertTeam(deps.db, "team1", "identity-team", "lead")
    insertMember(deps.db, "team1", "worker", "ses-worker")
    try {
      await git(root, "init")
      await git(root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "base")
      const directory = path.join(root, "worker")
      await git(root, "worktree", "add", "-b", "ensemble-worker", directory)
      deps.db.run("UPDATE team_member SET worktree_dir=?,worktree_branch='ensemble-worker' WHERE team_id='team1'", [directory])
      deps.db.run("UPDATE team_member SET worktree_identity=? WHERE team_id='team1'", [JSON.stringify(await inspectWorktreeIdentity(directory))])
      await git(root, "worktree", "remove", directory)
      await mkdir(directory)
      await expect(preserveMemberHead(deps.db, "team1", "worker", root)).rejects.toThrow()
      expect(await git(root, "branch", "--list", "ensemble/preserved/*")).toBe("")
      expect(deps.db.query("SELECT worktree_branch FROM team_member WHERE name='worker'").get()).toMatchObject({ worktree_branch: "ensemble-worker" })
    } finally { deps.db.close(); await rm(root, { recursive: true, force: true }) }
  })

  test("rejects another linked checkout recreated at the same path", async () => {
    const root = await mkdtemp("/tmp/opencode/reused-worktree-")
    const deps = setupDeps()
    insertTeam(deps.db, "team1", "identity-team", "lead")
    insertMember(deps.db, "team1", "worker", "ses-worker")
    try {
      await git(root, "init")
      await git(root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "base")
      const directory = path.join(root, "worker")
      await git(root, "worktree", "add", "-b", "ensemble-original", directory)
      const identity = await inspectWorktreeIdentity(directory)
      deps.db.run("UPDATE team_member SET worktree_dir=?,worktree_branch='ensemble-original',worktree_identity=? WHERE team_id='team1'", [directory, JSON.stringify(identity)])
      await git(root, "worktree", "remove", directory)
      await git(root, "worktree", "add", "-b", "somebody-elses-work", directory)
      await expect(preserveMemberHead(deps.db, "team1", "worker", root)).rejects.toThrow("identity mismatch")
      expect(await git(directory, "branch", "--show-current")).toBe("somebody-elses-work")
    } finally { deps.db.close(); await rm(root, { recursive: true, force: true }) }
  })
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
      deps.db.run("UPDATE team_member SET worktree_identity=? WHERE team_id='team1'", [JSON.stringify(await inspectWorktreeIdentity(directory))])
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
