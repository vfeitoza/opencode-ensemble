/** @jsxImportSource @opentui/solid */
import "@opentui/solid"
import { createSignal, createEffect, onCleanup, onMount, Show } from "solid-js"
import { Plugin } from "@opencode/plugin/tui"
import { EnsembleRpc } from "./rpc"
import { fetchTeamContext, type TeamContextData } from "./tui-context"
import { buildSidebarTasks } from "./tui-view"
import { createSidebarLoader, type SidebarLoadState } from "./tui-sidebar-state"

/** Sidebar widget: team members with status plus task counts. */
function TeamSidebar(props: { sessionID?: string; fetchContext: () => Promise<TeamContextData | null>; onEvent: (cb: () => void) => () => void }) {
  const [loadState, setLoadState] = createSignal<SidebarLoadState>({ status: "loading" })
  const state = () => { const current = loadState(); return current.status === "ready" ? current.data : current.status === "error" ? current.lastData : null }
  const loader = createSidebarLoader(() => props.fetchContext(), setLoadState)
  const load = () => loader.load(props.sessionID)
  createEffect(() => { void loader.load(props.sessionID) })
  onMount(() => {
    onCleanup(loader.dispose)
    const off = props.onEvent(() => void load())
    onCleanup(off)
    // Heartbeat: events alone go stale (cleanup emits nothing, events can be
    // missed across reconnects). Re-fetch on a slow tick — local RPC read.
    const tick = setInterval(() => void load(), 10_000)
    onCleanup(() => clearInterval(tick))
  })
  return (
    <box flexDirection="column">
    <Show when={loadState().status === "error"}><text>Ensemble: erro de consulta — reconectando{state()?.team ? " (dados desatualizados)" : ""}</text></Show>
    <Show when={loadState().status !== "loading"} fallback={<text>Ensemble: carregando…</text>}>
    <Show when={state()?.team} fallback={loadState().status === "ready" ? <text>Ensemble: no active team</text> : null}>
      <box flexDirection="column">
        <text>Ensemble: {state()?.team}</text>
        {(state()?.members ?? []).map((member) => (
          <text>
            {member.status === "busy" ? "●" : member.status === "ready" ? "○" : "■"} {member.name} ({member.status})
          </text>
        ))}
        <Show when={(state()?.openTasks?.length ?? 0) > 0}>
          <text>Tarefas abertas:</text>
          {buildSidebarTasks(state()?.openTasks ?? [], state()?.openTaskTotal ?? state()?.tasks.pending ?? 0).rows.map((lines) => (
            <box flexDirection="column">
              {lines.map((line) => <text>{line}</text>)}
            </box>
          ))}
          <Show when={buildSidebarTasks(state()?.openTasks ?? [], state()?.openTaskTotal ?? state()?.tasks.pending ?? 0).hidden > 0}>
            <text>+{buildSidebarTasks(state()?.openTasks ?? [], state()?.openTaskTotal ?? state()?.tasks.pending ?? 0).hidden} tarefas abertas</text>
          </Show>
        </Show>
        <text>
          tasks: {(state()?.tasks.pending ?? 0)} open / {(state()?.tasks.done ?? 0)} done
        </text>
      </box>
    </Show>
    </Show>
    </box>
  )
}

/**
 * Terminal companion for opencode-ensemble (issue #36).
 *
 * Two persistent surfaces only — transient toasts were removed as noise
 * (live state lives in the sidebar; events live in the transcript as
 * synthetic system lines):
 *   1. Sidebar widget: live member status + task counts.
 *   2. Native agent switching: team_view with navigate: true (user opt-in
 *      only — agents never hijack the client unprompted).
 *
 * Enhancement only: desktop, web, and companion-less terminals lose nothing
 * functional — tools, approvals, model-context messages, and the dashboard
 * all live server-side.
 */
export default Plugin.define({
  id: "ensemble.tui",
  setup(context) {
    const rpc = context.client.rpc(EnsembleRpc)

    // Native agent switching: team_view(navigate: true) emits "view";
    // the companion navigates the TUI to the teammate session (ctrl+p to return).
    const offView = rpc.events.on("view", (event) => {
      const data = event.data as unknown as { sessionID: string }
      if (!data.sessionID) return
      if (context.ui.tabs.enabled()) {
        void context.ui.tabs.focus(data.sessionID)
      } else {
        void context.ui.router.navigate({ type: "session", sessionID: data.sessionID })
      }
    })

    const onEvent = (cb: () => void): (() => void) => rpc.events.on("member", cb)

    const offSidebar = context.ui.slot({
      append: "sidebar.content",
      render: (panel: { sessionID?: string }) => (
        <TeamSidebar
          sessionID={panel.sessionID}
          fetchContext={() => fetchTeamContext(context, rpc, panel.sessionID)}
          onEvent={onEvent}
        />
      ),
    })

    return () => {
      offView()
      offSidebar()
    }
  },
})
