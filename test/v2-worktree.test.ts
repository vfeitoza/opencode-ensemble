import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { runCommand } from "../src/process"
import { ensureWorktreeBranch } from "../src/v2-worktree"

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await runCommand(["git", ...args], { cwd })
  if (result.exitCode !== 0) throw new Error(result.stderr)
  return result.stdout.trim()
}

async function fixture() {
  const root = await mkdtemp("/tmp/opencode/worktree-contract-")
  await git(root, "init")
  await git(root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "base")
  const directory = path.join(root, "worker")
  await git(root, "worktree", "add", "--detach", directory)
  return { root, directory }
}

describe("V2 worktree branch establishment", () => {
  test("creates a real named branch from detached HEAD and verifies repeated lookup", async () => {
    const { root, directory } = await fixture()
    try {
      expect(await ensureWorktreeBranch(directory, "ensemble-test")).toBe("ensemble-test")
      expect(await git(directory, "symbolic-ref", "--short", "HEAD")).toBe("ensemble-test")
      expect(await git(root, "rev-parse", "refs/heads/ensemble-test")).toBe(await git(directory, "rev-parse", "HEAD"))
      expect(await ensureWorktreeBranch(directory, "ensemble-test")).toBe("ensemble-test")
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  test("ref collision leaves the existing branch and detached checkout untouched", async () => {
    const { root, directory } = await fixture()
    try {
      await git(root, "branch", "ensemble-collision")
      const tip = await git(root, "rev-parse", "ensemble-collision")
      await expect(ensureWorktreeBranch(directory, "ensemble-collision")).rejects.toThrow("already exists")
      expect(await git(root, "rev-parse", "ensemble-collision")).toBe(tip)
      expect(await git(directory, "branch", "--show-current")).toBe("")
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  test("rejects invalid branch names without checking out a new branch", async () => {
    const { root, directory } = await fixture()
    try {
      await expect(ensureWorktreeBranch(directory, "--force")).rejects.toThrow("Invalid")
      expect(await git(directory, "branch", "--show-current")).toBe("")
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  test("rejects a root checkout instead of modifying the lead branch", async () => {
    const { root } = await fixture()
    try {
      const original = await git(root, "branch", "--show-current")
      await expect(ensureWorktreeBranch(root, "ensemble-test")).rejects.toThrow("linked worktree")
      expect(await git(root, "branch", "--show-current")).toBe(original)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  test("rejects dirty detached checkout and missing directory without creating a branch", async () => {
    const { root, directory } = await fixture()
    try {
      await Bun.write(path.join(directory, "uncommitted.txt"), "keep me")
      await expect(ensureWorktreeBranch(directory, "ensemble-dirty")).rejects.toThrow("uncommitted")
      expect(await git(directory, "branch", "--show-current")).toBe("")
      await expect(ensureWorktreeBranch(path.join(root, "missing"), "ensemble-missing")).rejects.toThrow()
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
