import { randomUUID } from "node:crypto"
import { runCommand } from "./process"
import type { PluginClient } from "./types"
import { Service } from "@opencode/client/service"
import { InboxAccessError, decodeInboxError, normalizeInboxResult } from "./inbox-errors"

interface RpcPort {
  register(definition: unknown, handlers: Record<string, () => Promise<unknown>>): Promise<{ dispose?(): Promise<void> }>
}

/** Bind identity verification and inbox operations to one discovered authenticated endpoint. */
export async function createVerifiedInboxBridge(
  rpc: RpcPort,
  directory: string,
  invoke?: (args: string[]) => Promise<unknown>,
): Promise<{ inbox: NonNullable<PluginClient["session"]["inbox"]>; dispose(): Promise<void> }> {
  const endpoint = invoke ? undefined : await Service.discover()
  const call = invoke ?? (async (args: string[]): Promise<unknown> => {
    if (!endpoint) throw new InboxAccessError("transport", "No existing managed service discovered; inbox capability unavailable")
    const result = await runCommand(["opencode", "api", "--server", endpoint.url, ...args], {
      cwd: directory, timeoutMs: 10_000, env: { OPENCODE_PASSWORD: endpoint.auth?.password },
    })
    if (result.exitCode !== 0) {
      for (const output of [result.stdout, result.stderr]) {
        try {
          const parsed: unknown = JSON.parse(output.trim())
          throw decodeInboxError(parsed)
        } catch (error) { if (error instanceof InboxAccessError) throw error }
      }
      throw decodeInboxError(null)
    }
    try { return result.stdout.trim() ? JSON.parse(result.stdout) as unknown : undefined } catch {
      throw new InboxAccessError("invalid_response", "Invalid inbox API JSON")
    }
  })
  const nonce = randomUUID()
  const rpcID = `ensemble-inbox-${nonce}`
  const registration = await rpc.register({ id: rpcID, methods: { identity: { input: { type: "object" }, output: { type: "object", properties: { nonce: { type: "string" } }, required: ["nonce"] } } }, events: {} }, { identity: async () => ({ nonce }) })
  const verify = async (): Promise<void> => {
    const result = await call(["rpc.call", "--param", `rpcID=${rpcID}`, "--param", "method=identity", "--param", `location[directory]=${directory}`, "--data", '{"input":{}}']) as { output?: { nonce?: string } }
    if (result?.output?.nonce !== nonce) throw new Error("Inbox bridge server identity mismatch; cancellation blocked")
  }
  try { await verify() } catch (error) { await registration.dispose?.(); throw error }
  return {
    inbox: {
      list: async ({ sessionID }) => { await verify(); return normalizeInboxResult(await call(["session.inbox.list", "--param", `sessionID=${sessionID}`])) },
      cancel: async ({ sessionID, inboxID }) => { await verify(); return call(["session.inbox.cancel", "--param", `sessionID=${sessionID}`, "--param", `inboxID=${inboxID}`]) },
    },
    dispose: async () => { await registration.dispose?.() },
  }
}
