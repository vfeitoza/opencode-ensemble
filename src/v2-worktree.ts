import { realpath, stat } from "node:fs/promises"
import { runCommand } from "./process"

async function git(directory: string, args: string[]): Promise<string> {
  const result = await runCommand(["git", ...args], { cwd: directory })
  if (result.exitCode !== 0) throw new Error(`Worktree Git operation failed: ${result.stderr.trim() || args[0]}`)
  return result.stdout.trim()
}

/** Captured identity of a linked Git checkout; paths alone do not prove ownership. */
export interface WorktreeIdentity {
  root: string
  gitDir: string
  commonDir: string
  branch: string
  initialHead: string
  gitDirIdentity: string
}

/** Read and validate a linked checkout identity before assigning it to a worker. */
export async function inspectWorktreeIdentity(directory: string): Promise<WorktreeIdentity> {
  const root = await realpath(await git(directory, ["rev-parse", "--show-toplevel"]))
  if (root !== await realpath(directory)) throw new Error("Worktree identity mismatch: path is not checkout root")
  const gitDir = await realpath(await git(directory, ["rev-parse", "--absolute-git-dir"]))
  const commonDir = await realpath(await git(directory, ["rev-parse", "--path-format=absolute", "--git-common-dir"]))
  if (gitDir === commonDir || await git(directory, ["rev-parse", "--show-superproject-working-tree"])) throw new Error("Worktree identity mismatch: not a linked checkout")
  const identity = await stat(gitDir, { bigint: true })
  const inventory = await git(directory, ["worktree", "list", "--porcelain"])
  if (!inventory.split("\n").includes(`worktree ${root}`)) throw new Error("Checkout absent from Git worktree inventory")
  return { root, gitDir, commonDir, branch: await git(directory, ["symbolic-ref", "--short", "HEAD"]), initialHead: await git(directory, ["rev-parse", "HEAD"]), gitDirIdentity: `${identity.dev}:${identity.ino}:${identity.birthtimeNs}` }
}

/** Reject path reuse, another repository, symlink redirection, or a changed checkout. */
export async function verifyWorktreeIdentity(directory: string, expected: WorktreeIdentity): Promise<void> {
  const actual = await inspectWorktreeIdentity(directory)
  if (actual.root !== expected.root || actual.gitDir !== expected.gitDir || actual.commonDir !== expected.commonDir || actual.branch !== expected.branch || actual.gitDirIdentity !== expected.gitDirIdentity) throw new Error("Worktree identity mismatch; preservation/removal blocked")
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
