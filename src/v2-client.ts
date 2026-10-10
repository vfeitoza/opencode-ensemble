import type { PluginClient } from "./types"
import { ensureWorktreeBranch } from "./v2-worktree"

/** V2 plugin context subset Ensemble needs (structural, mock-friendly). */
export interface V2Context {
  session: {
    create(input: Record<string, unknown>): Promise<{ id: string }>
    prompt(input: Record<string, unknown>): Promise<unknown>
    switchAgent(input: Record<string, unknown>): Promise<unknown>
    switchModel(input: Record<string, unknown>): Promise<unknown>
    interrupt(input: Record<string, unknown>): Promise<unknown>
    get(input: Record<string, unknown>): Promise<unknown>
    context(input: Record<string, unknown>): Promise<unknown[]>
    active(): Promise<Record<string, { type: string }>>
    synthetic(input: Record<string, unknown>): Promise<unknown>
  }
  worktree: {
    create(input: Record<string, unknown>): Promise<{ directory: string }>
    remove(input: Record<string, unknown>): Promise<unknown>
    list(input: Record<string, unknown>): Promise<Array<{ directory: string; type?: string }>>
    refresh(input: Record<string, unknown>): Promise<unknown>
  }
  // OQ-V2-rules: host 2.0.4 removes permission.rules; the adapter
  // feature-detects it at runtime, so the type is optional here.
  permission: {
    rules?(input: Record<string, unknown>): Promise<unknown>
  }
}

/** Prefix marking a workspace id that is really a local directory (see below). */
const DIR_WORKSPACE_PREFIX = "v2dir:"

/** Injectable shell lookups (default to git; overridden in tests). */
export interface V2ClientDeps {
  /** Host project ID, distinct from the directory-keyed Ensemble project row. */
  projectID?: string
  /** Canonical checkout to exclude from host worktree inventory. */
  projectDirectory?: string
  /** Establish a real branch in the checkout returned by the host. */
  ensureBranch?: typeof ensureWorktreeBranch
  /** Worktree directory currently on a branch, or null when none. */
  gitDir?: (branch: string) => Promise<string | null>
  /** RPC emitter for companion events (team_view navigation). */
  rpcEmitter?: { events: { emit(name: string, data: unknown): Promise<unknown> } }
}

/** Concatenate the text parts of a promptAsync payload into one string. */
function joinParts(parts: Array<{ type: "text"; text: string }>): string {
  return parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
}

/**
 * Adapt a V2 plugin context to the shared PluginClient interface so all 14
 * team tools run unchanged on V2 (DRY: one adapter, zero logic forks).
 *
 * Mapping notes (all spike-verified live against v2.0.3 unless marked OQ):
 * - create: V1 `permission` rules become V2 `{action, resource, effect}`;
 *   `workspaceID`/`directory` nest under `location`.
 * - promptAsync: queue delivery wakes idle sessions; `agent` is applied via
 *   switchAgent first (V2 binds the agent at create/admission, and the shared
 *   create signature has no agent slot — only spawn passes one).
 * - abort: interrupt. status: derived from the active set — sessions absent
 *   from it read as idle, which matches the shutdown default (team-shutdown
 *   treats unknown as idle). OQ-V2-status: if V2 ever reports non-running
 *   states here, extend the mapping.
 * - tui.*: no-op. Toasts and session-select move to the CLI (`./tui`) plugin
 *   in a later phase — the server plugin must not depend on a TUI.
 * - worktree.create: the host project ID scopes every worktree operation;
 *   a detached checkout gets a verified named branch before it is returned.
 * - worktree.list: V2 entries carry directory only; name is the basename
 *   (recovery filters on the `ensemble-` prefix — a non-matching dir is
 *   skipped, never wrongly deleted). reset has no production callers and
 *   maps to refresh. OQ-V2-wtname.
 * - workspace.*: V2 ctx has no workspace domain (workspaces are
 *   provider-based). create bridges a branch to its worktree directory and
 *   returns a `v2dir:<dir>` id; session.create routes that id to
 *   location.directory, preserving worktree isolation with zero tool
 *   changes. list returns [] and remove resolves — the DB workspace_id
 *   column stays the source of truth and is still nulled by cleanup.
 */
export function createV2Client(ctx: V2Context, deps: V2ClientDeps = {}): PluginClient {
  const establishBranch = deps.ensureBranch ?? ensureWorktreeBranch
  const projectID = (): string => {
    if (!deps.projectID) throw new Error("V2 worktree operations require the host projectID")
    return deps.projectID
  }
  return {
    session: {
      create: async (options) => {
        const input: Record<string, unknown> = { title: options.title }
        if (options.parentID) input["parentID"] = options.parentID
        // V1 action names predate the V2 vocabulary: bash is now shell.
        const V1_ACTION_MAP: Record<string, string> = { bash: "shell" }
        const permissions = options.permission?.map((rule) => ({
          action: V1_ACTION_MAP[rule.permission] ?? rule.permission,
          resource: rule.pattern,
          effect: rule.action,
        }))
        if (permissions) input["permissions"] = permissions
        if (options.workspaceID ?? options.directory) {
          if (options.workspaceID?.startsWith(DIR_WORKSPACE_PREFIX)) {
            input["location"] = {
              directory: options.workspaceID.slice(DIR_WORKSPACE_PREFIX.length),
            }
          } else {
            input["location"] = {
              ...(options.directory ? { directory: options.directory } : {}),
              ...(options.workspaceID ? { workspaceID: options.workspaceID } : {}),
            }
          }
        }
        const created = await ctx.session.create(input)
        if (options.directory) {
          const session = await ctx.session.get({ sessionID: created.id }) as { location?: { directory?: string } }
          if (session.location?.directory !== options.directory) {
            throw new Error(`Session ${created.id} was not bound to ${options.directory}; refusing to start teammate`)
          }
        }
        if (permissions) {
          // Session.create permissions lose to agent rules (last match wins
          // and agent rules apply later), which strips team tools from
          // read-only agents. Re-assert here: rules() evaluates after the
          // agent's rules, restoring the tools. OQ-V2-rules.
          //
          // opencode >= 2.0.4 removed ctx.permission.rules, so the call is
          // feature-detected. Without the guard every team_spawn died with
          // "ctx.permission.rules is not a function" (issue #40). The re-assert
          // is skipped, not replaced: agent rules still win on 2.x, which
          // costs read-only agents their team tools.
          if (typeof ctx.permission.rules === "function") {
            await ctx.permission.rules({ sessionID: created.id, permissions })
          } else {
            // v2 host without permission.rules: session.create permissions
            // are last to win vs agent rules, so read-only agents may lose
            // their team tools. Log explicitly so it is never silent.
            console.warn(
              "[ensemble] ctx.permission.rules unavailable on this host; skipped permission re-assert — read-only agents may lose team tools. Requires host with permission.rules support."
            )
          }
        }
        return { data: { id: created.id } }
      },
      promptAsync: async (options) => {
        // Synthetic (system) messages render as persistent transcript entries
        // instead of fake user turns — the native form for agent notifications.
        if (options.synthetic) {
          return ctx.session.synthetic({
            sessionID: options.sessionID, text: joinParts(options.parts), delivery: "queue",
            ...(options.notification ? {
              id: options.notification.inboxId,
              metadata: { ensemble: { teamId: options.notification.teamId, messageId: options.notification.messageId, notificationId: options.notification.inboxId } },
            } : {}),
          })
        }
        if (options.agent) {
          await ctx.session.switchAgent({ sessionID: options.sessionID, agent: options.agent })
        }
        // V2 binds model at create/admission; the shared create signature has
        // no model slot, so apply it here (spawn is the only model passer).
        // Caught live: without this, teammates inherit the server default.
        if (options.model) {
          await ctx.session.switchModel({
            sessionID: options.sessionID,
            model: { providerID: options.model.providerID, id: options.model.modelID },
          })
        }
        const text = joinParts(options.parts)
        return ctx.session.prompt({ sessionID: options.sessionID, text, delivery: "queue" })
      },
      abort: async (options) => ctx.session.interrupt({ sessionID: options.sessionID, resume: false }),
      status: async () => {
        const active = await ctx.session.active()
        const data: Record<string, { type: string }> = {}
        for (const sessionID of Object.keys(active)) data[sessionID] = { type: "busy" }
        return { data }
      },
      messages: async (options) => {
        const messages = await ctx.session.context({ sessionID: options.sessionID })
        return { data: messages as Array<{ info: unknown; parts: unknown[] }> }
      },
      get: async (options) => {
        const data = await ctx.session.get({ sessionID: options.sessionID })
        return { data }
      },
    },
    tui: {
      showToast: async () => undefined,
      selectSession: async (options) => {
        // Native agent switching on V2: shared team_view calls this, the
        // companion receives the event and navigates the TUI to the
        // teammate session. No server-side TUI API exists on V2.
        if (deps.rpcEmitter) {
          await deps.rpcEmitter.events.emit("view", { sessionID: options.sessionID }).catch(() => {
            // Companion optional — never fail team_view for it.
          })
        }
        return undefined
      },
    },
    worktree: {
      create: async (options) => {
        const name = (options.worktreeCreateInput as { name?: string } | undefined)?.name ?? "ensemble-worktree"
        const created = await ctx.worktree.create({ projectID: projectID(), name })
        try {
          const branch = await establishBranch(created.directory, name)
          return { data: { name, branch, directory: created.directory } }
        } catch (error) {
          // OQ-202: retain the returned checkout for reconciliation rather than
          // deleting a directory/ref whose ownership or dirty state is unknown.
          throw new Error(`${error instanceof Error ? error.message : String(error)}. Worktree retained at ${created.directory}; no shared-directory fallback is safe.`)
        }
      },
      remove: async (options) => {
        const directory = (options.worktreeRemoveInput as { directory: string }).directory
        return ctx.worktree.remove({ projectID: projectID(), directory, force: false })
      },
      list: async () => {
        const entries = await ctx.worktree.list({ projectID: projectID() })
        return {
          data: entries.filter(entry => entry.type !== "root" && entry.directory !== deps.projectDirectory).map((entry) => ({
            name: entry.directory.split("/").pop() ?? entry.directory,
            branch: "",
            directory: entry.directory,
          })),
        }
      },
      reset: async () => ctx.worktree.refresh({ projectID: projectID() }),
    },
    workspace: {
      create: async (options) => {
        const branch = (options as { branch?: string }).branch ?? ""
        const directory = await deps.gitDir?.(branch)
        if (!directory) throw new Error(`V2 workspace bridge: no worktree found on branch "${branch}"`)
        return {
          data: {
            id: `${DIR_WORKSPACE_PREFIX}${directory}`,
            type: "local",
            branch,
            directory,
            projectID: "",
          },
        }
      },
      remove: async () => undefined,
      list: async () => ({
        data: [] as Array<{
          id: string
          type: string
          branch: string | null
          directory: string | null
          projectID: string
        }>,
      }),
    },
  } as PluginClient
}
