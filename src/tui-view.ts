import type { SidebarTask } from "./tui-context"

function cleanSidebarText(value: string): string {
  // Deliberately remove terminal controls; dynamic construction avoids embedding
  // literal control codepoints in the regex source checked by the linter.
  const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "g")
  return Array.from(value.replace(ansi, "")).map(point => {
    const code = point.codePointAt(0) ?? 0
    return code < 32 || (code >= 127 && code <= 159) ? " " : point
  }).join("").replace(/\s+/g, " ").trim()
}

/** Bound sidebar task density independently of full task storage. */
export function buildSidebarTasks(tasks: SidebarTask[], totalOpen: number): { rows: string[][]; hidden: number } {
  const visible = tasks.slice(0, 5)
  return { rows: visible.map(formatSidebarTask), hidden: Math.max(0, totalOpen - visible.length) }
}

/** Format an open task's state, description, and assignment for the sidebar. */
export function formatSidebarTask(task: SidebarTask): string[] {
  const clean = cleanSidebarText(task.content)
  const points = Array.from(clean)
  const content = points.length > 120 ? `${points.slice(0, 119).join("")}…` : clean
  const owner = cleanSidebarText(task.assignee ?? "não atribuído")
  return [
    `□ [${task.status}] ${content}`,
    `  responsável: ${owner}`,
  ]
}

/** Minimal member shape for sidebar rendering. */
export interface SidebarMember {
  name: string
  status: string
}

/** Rendered sidebar model: counts plus one line per member. */
export interface SidebarSummary {
  team: string
  working: number
  idle: number
  total: number
  lines: string[]
}

/** Glyph per member status (paired with text elsewhere — never color-only). */
function glyph(status: string): string {
  switch (status) {
    case "busy":
      return "●"
    case "ready":
      return "○"
    case "shutdown_requested":
      return "◐"
    case "shutdown":
      return "■"
    case "error":
      return "✕"
    default:
      return "?"
  }
}

/**
 * Build the sidebar model for a team. Busy members count as working, ready
 * as idle, terminal states (shutdown/error) as done.
 */
export function summarizeMembers(team: string, members: SidebarMember[]): SidebarSummary {
  if (members.length === 0) {
    return { team, working: 0, idle: 0, total: 0, lines: ["No teammates"] }
  }
  let working = 0
  let idle = 0
  const lines = members.map((member) => {
    if (member.status === "busy") working += 1
    else if (member.status === "ready") idle += 1
    return `${glyph(member.status)} ${member.name} (${member.status})`
  })
  return { team, working, idle, total: members.length, lines }
}
