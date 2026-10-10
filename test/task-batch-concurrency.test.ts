import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { createDb, withImmediateTransaction } from "../src/db"

test("a separate process cannot commit a partial batch while another writer holds the lock", async () => {
  const root = await mkdtemp("/tmp/opencode/task-lock-")
  const filename = path.join(root, "lock.db")
  const db = createDb(filename)
  db.exec("CREATE TABLE lock_proof(id INTEGER PRIMARY KEY)")
  const adapter = path.resolve(import.meta.dir, "../src/db.ts")
  try {
    db.exec("BEGIN IMMEDIATE")
    db.exec("INSERT INTO lock_proof VALUES(1)")
    const script = `import {createDb,withImmediateTransaction} from ${JSON.stringify(adapter)};const db=createDb(${JSON.stringify(filename)});db.exec('PRAGMA busy_timeout=0');try{withImmediateTransaction(db,()=>db.exec('INSERT INTO lock_proof VALUES(2)'));process.exitCode=1}catch{process.exitCode=0}db.close()`
    const process = Bun.spawn(["bun", "-e", script], { stdout: "pipe", stderr: "pipe" })
    expect(await process.exited).toBe(0)
    db.exec("COMMIT")
    expect(db.query("SELECT id FROM lock_proof").all()).toEqual([{ id: 1 }])
    expect(() => withImmediateTransaction(db, () => { db.exec("INSERT INTO lock_proof VALUES(3)"); db.exec("INSERT INTO lock_proof VALUES(3)") })).toThrow()
    expect(db.query("SELECT id FROM lock_proof").all()).toEqual([{ id: 1 }])
  } finally { db.close(); await rm(root, { recursive: true, force: true }) }
})
