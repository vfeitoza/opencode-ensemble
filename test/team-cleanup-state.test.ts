import { expect, test } from "bun:test"
import { setupDb } from "./helpers"
import { beginCleanup, blockCleanup, advanceCleanup, finishCleanup, assertTeamAcceptsWork } from "../src/team-cleanup-state"

test("cleanup CAS excludes concurrent operations and blocked phases are retryable", () => {
  const db = setupDb()
  try {
    const first = beginCleanup(db, "team")
    expect(() => beginCleanup(db, "team")).toThrow("already in progress")
    expect(() => assertTeamAcceptsWork(db, "team")).toThrow("pending")
    advanceCleanup(db, first, "cancelling")
    blockCleanup(db, first, new Error("inbox failed"))
    expect(() => assertTeamAcceptsWork(db, "team")).toThrow()
    const next = beginCleanup(db, "team")
    expect(() => advanceCleanup(db, first, "removing")).toThrow("ownership")
    finishCleanup(db, first)
    expect(() => beginCleanup(db, "team")).toThrow()
    finishCleanup(db, next)
    expect(() => assertTeamAcceptsWork(db, "team")).not.toThrow()
  } finally { db.close() }
})
