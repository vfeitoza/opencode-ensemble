import type { TeamContextData } from "./tui-context"

/** Distinguish a successful empty team from RPC or location failure. */
export type SidebarLoadState = { status: "loading" } | { status: "ready"; data: TeamContextData | null } | { status: "error"; message: string; lastData?: TeamContextData | null }

/** Load sidebar state while rejecting late responses belonging to another session. */
export function createSidebarLoader(fetchContext: () => Promise<TeamContextData | null>, publish: (state: SidebarLoadState) => void) {
  let generation = 0
  let session: string | undefined
  let lastData: TeamContextData | null | undefined
  let disposed = false
  return {
    load: async (sessionID?: string): Promise<void> => {
      if (disposed) return
      const request = ++generation
      if (session !== sessionID) { session = sessionID; lastData = undefined; publish({ status: "loading" }) }
      try {
        const data = await fetchContext()
        if (disposed || request !== generation) return
        lastData = data
        publish({ status: "ready", data })
      } catch (error) {
        if (!disposed && request === generation) publish({ status: "error", message: error instanceof Error ? error.message : String(error), lastData })
      }
    },
    dispose: () => { disposed = true; generation += 1 },
  }
}
