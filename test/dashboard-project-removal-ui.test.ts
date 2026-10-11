import { expect, test } from "bun:test"
import { runInNewContext } from "node:vm"
import { DASHBOARD_JS_PROJECT_REMOVAL } from "../src/dashboard-js-project-removal"
import { DASHBOARD_JS_CORE } from "../src/dashboard-js-core"
import { DASHBOARD_JS_RENDER } from "../src/dashboard-js-render"

function ui(preview: Record<string, unknown>) {
  const nodes = new Map<string, { textContent: string; value: string; disabled: boolean; open: boolean; innerHTML: string; showModal(): void; close(): void; focus(): void }>()
  const node = (id: string) => {
    if (!nodes.has(id)) nodes.set(id, { textContent: "", value: "", disabled: false, open: false, innerHTML: "", showModal() { this.open = true }, close() { this.open = false }, focus() {} })
    return nodes.get(id)!
  }
  const calls: Array<{ route: string; options: { body: string } }> = []
  const context = {
    document: { getElementById: node, activeElement: { focus() {} }, querySelector: () => ({ content: "write-token" }) },
    AbortController, JSON, console,
    closeDrawer() {}, closeShortcuts() {}, render() {}, poll: async () => {},
    fetch: async (route: string, options: { body: string }) => { calls.push({ route, options }); return { ok: true, json: async () => route.endsWith("removal-preview") ? preview : { removed: true } } },
  }
  const api = runInNewContext(DASHBOARD_JS_CORE + DASHBOARD_JS_PROJECT_REMOVAL + `\n({openProjectRemoval,confirmProjectRemoval,updateProjectRemovalConfirm,closeProjectRemoval})`, context) as { openProjectRemoval(id: string): Promise<void>; confirmProjectRemoval(e: { preventDefault(): void }): Promise<void>; updateProjectRemovalConfirm(): void; closeProjectRemoval(): void }
  return { api, node, calls, context }
}
const preview = { project: { id: "p", name: 'Project <unsafe>', path: '/code/"project' }, counts: { teams: 2, members: 3, tasks: 4, messages: 900, notifications: 2, spawnResources: 1 }, blockers: [], token: "confirmation" }

test("project removal requires exact typed name, shows full counts and sends bound confirmation", async () => {
  const u = ui(preview)
  await u.api.openProjectRemoval("p")
  expect(u.node("project-removal").open).toBe(true)
  expect(u.node("project-removal-name").textContent).toBe('Project <unsafe>')
  expect(u.node("project-removal-counts").textContent).toContain("900 messages")
  expect(u.node("project-removal-confirm").disabled).toBe(true)
  u.node("project-removal-input").value = "wrong"
  u.api.updateProjectRemovalConfirm()
  expect(u.node("project-removal-confirm").disabled).toBe(true)
  u.node("project-removal-input").value = 'Project <unsafe>'
  u.api.updateProjectRemovalConfirm()
  expect(u.node("project-removal-confirm").disabled).toBe(false)
  await u.api.confirmProjectRemoval({ preventDefault() {} })
  expect(JSON.parse(u.calls[1]!.options.body)).toEqual({ projectId: "p", token: "confirmation", name: 'Project <unsafe>' })
  expect(u.node("project-removal").open).toBe(false)
})

test("blockers forbid submission and closing preview cannot issue a removal", async () => {
  const u = ui({ ...preview, blockers: ["Archive active teams first."], token: null })
  await u.api.openProjectRemoval("p")
  u.node("project-removal-input").value = 'Project <unsafe>'
  u.api.updateProjectRemovalConfirm()
  await u.api.confirmProjectRemoval({ preventDefault() {} })
  expect(u.calls).toHaveLength(1)
  expect(u.node("project-removal-error").textContent).toContain("Archive")
  u.api.closeProjectRemoval()
  expect(u.node("project-removal").open).toBe(false)
})

test("removal button encodes dangerous IDs as data, not inline executable code", () => {
  const renderButton = runInNewContext(DASHBOARD_JS_CORE + DASHBOARD_JS_RENDER + "\nrenderProjectSection", { console }) as (p: Record<string, unknown>, cp: null, c: null) => string
  const html = renderButton({ id: 'p" onclick="alert(1)', name: "X", teams: [] }, null, null)
  expect(html).toContain('data-remove-project="p&quot; onclick=&quot;alert(1)"')
  expect(html).not.toContain('onclick="alert(1)"')
})
