import { createV2Client, type V2Context } from "../src/v2-client"
import { runCommand } from "../src/process"

/** Exercise the public adapter against an explicitly isolated authenticated server. */
export async function verifyV2WorktreeContract(ctx: V2Context, projectID: string): Promise<void> {
  const client = createV2Client(ctx, { projectID })
  const names = ["ensemble-contract-worker-a", "ensemble-contract-worker-b"].map(name => `${name}-${Date.now()}`)
  const results = await Promise.all(names.map(name => client.worktree.create({ worktreeCreateInput: { name } })))
  for (const result of results) {
    if (!result.data) throw new Error("Missing worktree result")
    const git = await runCommand(["git", "symbolic-ref", "--short", "HEAD"], { cwd: result.data.directory })
    if (git.exitCode !== 0 || git.stdout.trim() !== result.data.branch) throw new Error("No verified branch")
    console.log(JSON.stringify(result.data))
  }
  await client.worktree.reset({})
  const inventory = await client.worktree.list()
  if (results.some(result => !inventory.data?.some(tree => tree.directory === result.data?.directory))) throw new Error("Created worktrees missing from inventory")
  // Scratch directories contain no agent work; remove only the resources created here.
  for (const result of results) {
    await client.worktree.remove({ worktreeRemoveInput: { directory: result.data!.directory } })
  }
  console.log("worktree-contract: verified two branches and project-scoped create/list/refresh/remove")
}
