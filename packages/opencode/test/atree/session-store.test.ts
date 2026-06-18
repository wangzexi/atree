import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { readSessionStores, writeSessionStore } from "../../src/atree/session-store"

const temps: string[] = []

async function tempdir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "atree-session-store-"))
  temps.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

describe("atree session store", () => {
  test("overwrites meta.yaml while preserving session payload files", async () => {
    const directory = await tempdir()
    const base = {
      id: "ses_test",
      slug: "ses-test",
      version: "test",
      projectID: "proj_test",
      directory,
      path: ".",
      title: "First title",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 1, updated: 2 },
    }

    await writeSessionStore({ ...base, metadata: { icon: "🦊" } } as any)
    await writeSessionStore({
      ...base,
      title: "Second title",
      metadata: { icon: "🧭" },
      time: { created: 1, updated: 3, archived: 4 },
    } as any)

    const root = path.join(directory, ".agents", "atree", "sessions", "ses_test")
    const meta = await fs.readFile(path.join(root, "meta.yaml"), "utf8")
    expect(meta).toContain('title: "Second title"')
    expect(meta).toContain("updatedAt: 3")
    expect(meta).toContain("archivedAt: 4")
    expect(meta).toContain('metadata: {"icon":"🧭"}')
    expect(meta).not.toContain("First title")
    expect((await fs.stat(path.join(root, "session.jsonl"))).isFile()).toBe(true)
    expect((await fs.stat(path.join(root, "assets"))).isDirectory()).toBe(true)
  })

  test("reads session metadata from directory index sorted by updated time", async () => {
    const directory = await tempdir()
    const base = {
      slug: "session",
      version: "test",
      projectID: "proj_test",
      directory,
      path: ".",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 1, updated: 1 },
    }

    await writeSessionStore({ ...base, id: "ses_old", title: "Old", metadata: { icon: "🦊" } } as any)
    await writeSessionStore({
      ...base,
      id: "ses_new",
      title: "New",
      metadata: { icon: "🧭" },
      time: { created: 2, updated: 3, archived: 4 },
    } as any)

    const sessions = await readSessionStores(directory)
    expect(sessions.map((session) => String(session.id))).toEqual(["ses_new", "ses_old"])
    expect(sessions[0]?.title).toBe("New")
    expect(sessions[0]?.metadata).toEqual({ icon: "🧭" })
    expect(sessions[0]?.time.archived).toBe(4)
    expect(sessions[1]?.title).toBe("Old")
  })
})
