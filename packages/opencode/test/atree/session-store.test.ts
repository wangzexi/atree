import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { appendSessionJsonl, readSessionJsonlMessages, readSessionStores, writeSessionStore } from "../../src/atree/session-store"

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

  test("appends raw session events to session.jsonl", async () => {
    const directory = await tempdir()
    const session = {
      id: "ses_log",
      slug: "ses-log",
      version: "test",
      projectID: "proj_test",
      directory,
      title: "Log",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 1, updated: 1 },
    } as any

    await writeSessionStore(session)
    await appendSessionJsonl(session, { type: "message.updated", message: { id: "msg_one" } })
    await appendSessionJsonl(session, { type: "part.updated", part: { id: "prt_one" } })

    const lines = (
      await fs.readFile(path.join(directory, ".agents", "atree", "sessions", "ses_log", "session.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatchObject({ version: 1, type: "message.updated", message: { id: "msg_one" } })
    expect(lines[1]).toMatchObject({ version: 1, type: "part.updated", part: { id: "prt_one" } })
  })

  test("replays session.jsonl into messages with parts", async () => {
    const directory = await tempdir()
    const session = {
      id: "ses_replay",
      slug: "ses-replay",
      version: "test",
      projectID: "proj_test",
      directory,
      title: "Replay",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 1, updated: 1 },
    } as any

    await writeSessionStore(session)
    await appendSessionJsonl(session, {
      type: "message.updated",
      message: { id: "msg_one", sessionID: "ses_replay", role: "user", time: { created: 1 } },
    })
    await appendSessionJsonl(session, {
      type: "message.part.updated",
      part: { id: "prt_one", sessionID: "ses_replay", messageID: "msg_one", type: "text", text: "hello" },
    })
    await appendSessionJsonl(session, {
      type: "message.part.delta",
      sessionID: "ses_replay",
      messageID: "msg_one",
      partID: "prt_one",
      field: "text",
      delta: " world",
    })
    await appendSessionJsonl(session, {
      type: "message.updated",
      message: { id: "msg_two", sessionID: "ses_replay", role: "assistant", time: { created: 2 } },
    })
    await appendSessionJsonl(session, {
      type: "message.part.updated",
      part: { id: "prt_two", sessionID: "ses_replay", messageID: "msg_two", type: "text", text: "removed" },
    })
    await appendSessionJsonl(session, { type: "message.part.removed", messageID: "msg_two", partID: "prt_two" })
    await appendSessionJsonl(session, { type: "message.removed", messageID: "msg_two" })

    const messages = await readSessionJsonlMessages(session)
    expect(messages).toHaveLength(1)
    expect(messages[0]?.info).toMatchObject({ id: "msg_one", role: "user" })
    expect(messages[0]?.parts).toHaveLength(1)
    expect(messages[0]?.parts[0]).toMatchObject({ id: "prt_one", type: "text", text: "hello world" })
  })
})
