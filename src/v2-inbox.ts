import { randomUUID } from "node:crypto"
import { runCommand } from "./process"
import type { PluginClient } from "./types"
import { Service } from "@opencode/client/service"

interface RpcPort {
  register(definition: unknown, handlers: Record<string, () => Promise<unknown>>): Promise<{ dispose?(): Promise<void> }>
}

/** Bridge the public CLI inbox API only after proving it reaches this exact plugin host. */
export async function createVerifiedInboxBridge(
  rpc: RpcPort,
  directory: string,
  invoke: (args: string[]) => Promise<unknown> = async args => {
    // Discovery is read-only: never call ensure/start when establishing this
    // optional bridge, since that could launch an unrelated shared service.
    const endpoint = await Service.discover()
    if (!endpoint) throw new Error("No existing managed service discovered; native inbox or explicit host bridge required")
    const result = await runCommand(["opencode", "api", "--server", endpoint.url, ...args], {
      cwd: directory, timeoutMs: 10_000,
      env: { OPENCODE_PASSWORD: endpoint.auth?.password },
    })
    if (result.exitCode !== 0) throw new Error(`OpenCode inbox API failed: ${result.stderr.trim() || result.stdout.trim()}`)
    return result.stdout.trim() ? JSON.parse(result.stdout) as unknown : undefined
  },
): Promise<{ inbox: NonNullable<PluginClient["session"]["inbox"]>; dispose(): Promise<void> }> {
  const nonce = randomUUID()
  const rpcID = `ensemble-inbox-${nonce}`
  const registration = await rpc.register({ id: rpcID, methods: { identity: { input: { type: "object" }, output: { type: "object", properties: { nonce: { type: "string" } }, required: ["nonce"] } } }, events: {} }, { identity: async () => ({ nonce }) })
  const verify = async (): Promise<void> => {
    const result = await invoke(["rpc.call", "--param", `rpcID=${rpcID}`, "--param", "method=identity", "--param", `location[directory]=${directory}`, "--data", '{"input":{}}']) as { output?: { nonce?: string } }
    if (result?.output?.nonce !== nonce) throw new Error("Inbox bridge server identity mismatch; cancellation blocked")
  }
  try { await verify() } catch (error) { await registration.dispose?.(); throw error }
  return {
    inbox: {
      list: async ({ sessionID }) => {
        await verify()
        return await invoke(["session.inbox.list", "--param", `sessionID=${sessionID}`]) as { data: Array<{ id: string; type: string; metadata?: Record<string, unknown> }> }
      },
      cancel: async ({ sessionID, inboxID }) => {
        await verify()
        return invoke(["session.inbox.cancel", "--param", `sessionID=${sessionID}`, "--param", `inboxID=${inboxID}`])
      },
    },
    dispose: async () => { await registration.dispose?.() },
  }
}
