import { expect, test } from "bun:test"
import { setupDeps, insertTeam } from "./helpers"
import { startDashboard } from "../src/dashboard"

async function fixture() {
  const deps = setupDeps()
  insertTeam(deps.db, "old", "old", "lead", "archived")
  const port = 30000 + Math.floor(Math.random() * 8000)
  const server = await startDashboard(deps.db, port, deps)
  const base = `http://localhost:${port}`
  const html = await (await fetch(base)).text()
  const token = html.match(/name="ensemble-write-token" content="([^"]+)"/)?.[1] ?? "missing"
  const request = (route: string, body: unknown, headers: Record<string, string> = {}) => fetch(base + route, { method: "POST", headers: { "Content-Type": "application/json", "X-Ensemble-Token": token, Origin: base, ...headers }, body: JSON.stringify(body) })
  return { deps, server, base, html, request }
}

test("dashboard preview and confirmed removal delete history and refresh state", async () => {
  const f = await fixture()
  try {
    const previewResponse = await f.request("/api/projects/removal-preview", { projectId: "/tmp/test-project" })
    expect(previewResponse.status).toBe(200)
    expect(previewResponse.headers.has("access-control-allow-origin")).toBe(false)
    const preview = await previewResponse.json() as { token: string; counts: { teams: number } }
    expect(preview.counts.teams).toBe(1)
    const response = await f.request("/api/projects/remove", { projectId: "/tmp/test-project", token: preview.token, name: "test-project" })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ removed: true })
    expect((await (await fetch(f.base + "/api/state")).json() as { teams: unknown[] }).teams).toEqual([])
    expect(f.deps.db.query("SELECT id FROM project WHERE id='/tmp/test-project'").get()).toBeNull()
  } finally { f.server?.stop(true); f.deps.db.close() }
})

test("write routes reject wrong token, cross-origin, incorrect method and malformed input", async () => {
  const f = await fixture()
  try {
    expect((await f.request("/api/projects/removal-preview", { projectId: "/tmp/test-project" }, { "X-Ensemble-Token": "bad" })).status).toBe(403)
    expect((await f.request("/api/projects/removal-preview", { projectId: "/tmp/test-project" }, { Origin: "https://evil.example" })).status).toBe(403)
    expect((await fetch(f.base + "/api/projects/remove")).status).toBe(405)
    expect((await f.request("/api/projects/removal-preview", {})).status).toBe(400)
    expect((await f.request("/api/projects/removal-preview", { projectId: "x".repeat(20000) })).status).toBe(413)
    expect((await f.request("/api/projects/removal-preview", { projectId: "not-found" })).status).toBe(404)
    expect(f.deps.db.query("SELECT id FROM team WHERE id='old'").get()).toBeTruthy()
  } finally { f.server?.stop(true); f.deps.db.close() }
})

test("projects with no teams remain visible and can be removed without a host client", async () => {
  const f = await fixture()
  try {
    f.deps.db.run("INSERT INTO project(id,name,path,status,time_created,time_updated) VALUES('empty','Empty','/empty','active',0,0)")
    const state = await (await fetch(f.base + "/api/state")).json() as { projects: Array<{ id: string }> }
    expect(state.projects.some(p => p.id === "empty")).toBe(true)
    const preview = await (await f.request("/api/projects/removal-preview", { projectId: "empty" })).json() as { token: string }
    expect((await f.request("/api/projects/remove", { projectId: "empty", token: preview.token, name: "Empty" })).status).toBe(200)
  } finally { f.server?.stop(true); f.deps.db.close() }
})
