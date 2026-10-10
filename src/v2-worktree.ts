import { realpath } from "node:fs/promises"
import { runCommand } from "./process"

async function git(directory: string, args: string[]): Promise<string> {
  const result = await runCommand(["git", ...args], { cwd: directory })
  if (result.exitCode !== 0) throw new Error(`Worktree Git operation failed: ${result.stderr.trim() || args[0]}`)
  return result.stdout.trim()
}

/** Establish a verified branch in a newly created V2 worktree, without overwriting refs. */
export async function ensureWorktreeBranch(directory: string, requestedName: string): Promise<string> {
  if (!requestedName || requestedName.startsWith("-")) throw new Error("Invalid worktree branch name")
  const valid = await runCommand(["git", "check-ref-format", "--branch", requestedName], { cwd: directory })
  if (valid.exitCode !== 0) throw new Error(`Invalid worktree branch name: ${requestedName}`)
  const root = await git(directory, ["rev-parse", "--show-toplevel"])
  if (await realpath(root) !== await realpath(directory)) throw new Error("Expected the root of a linked worktree")
  const gitDir = await git(directory, ["rev-parse", "--absolute-git-dir"])
  const commonDir = await git(directory, ["rev-parse", "--path-format=absolute", "--git-common-dir"])
  if (await realpath(gitDir) === await realpath(commonDir)) throw new Error("Expected a linked worktree, not the lead checkout")
  if (await git(directory, ["rev-parse", "--show-superproject-working-tree"])) throw new Error("Expected a linked worktree, not a submodule")
  const current = await git(directory, ["branch", "--show-current"])
  if (current === requestedName) return current
  if (current) throw new Error(`Worktree already uses another branch: ${current}`)
  if (await git(directory, ["status", "--porcelain"])) throw new Error("Worktree contains uncommitted changes; refusing to change branches")
  const exists = await runCommand(["git", "show-ref", "--verify", "--quiet", `refs/heads/${requestedName}`], { cwd: directory })
  if (exists.exitCode === 0) throw new Error(`Worktree branch already exists: ${requestedName}`)
  if (exists.exitCode !== 1) throw new Error("Unable to check worktree branch ownership")
  const head = await git(directory, ["rev-parse", "HEAD"])
  await git(directory, ["switch", "-c", requestedName])
  const branch = await git(directory, ["symbolic-ref", "--short", "HEAD"])
  const tip = await git(directory, ["rev-parse", `refs/heads/${requestedName}`])
  if (branch !== requestedName || tip !== head) throw new Error("Worktree branch verification failed")
  return branch
}
