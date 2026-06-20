import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import {
  appendSessionJsonl,
  findSessionStore,
  readSessionJsonlMessages,
  readSessionJsonlProjection,
  readSessionStore,
  readSessionStores,
  writeSessionStore,
} from "../../src/atree/session-store"

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
    const directoryMeta = await fs.readFile(path.join(directory, ".agents", "atree", "meta.yaml"), "utf8")
    const meta = await fs.readFile(path.join(root, "meta.yaml"), "utf8")
    expect(directoryMeta).toContain("version: 1")
    expect(directoryMeta).toContain('source: "atree"')
    expect(directoryMeta).not.toContain("ses_test")
    expect(meta).toContain('title: "Second title"')
    expect(meta).toContain("updatedAt: 3")
    expect(meta).toContain("archivedAt: 4")
    expect(meta).toContain('projectID: "proj_test"')
    expect(meta).toContain("workspaceID: null")
    expect(meta).toContain('metadata: {"icon":"🧭"}')
    expect(meta).not.toContain("First title")
    expect(meta).not.toContain("directory:")
    expect(meta).not.toContain("source:")
    expect(meta).not.toContain(directory)
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

  test("keeps existing directory meta when writing sessions", async () => {
    const directory = await tempdir()
    await fs.mkdir(path.join(directory, ".agents", "atree"), { recursive: true })
    await fs.writeFile(path.join(directory, ".agents", "atree", "meta.yaml"), 'version: 1\ntitle: "Content Ops"\n')

    await writeSessionStore({
      id: "ses_keep_meta",
      slug: "keep-meta",
      version: "test",
      projectID: "proj_test",
      directory,
      path: ".",
      title: "Session",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 1, updated: 1 },
    } as any)

    expect(await fs.readFile(path.join(directory, ".agents", "atree", "meta.yaml"), "utf8")).toBe(
      'version: 1\ntitle: "Content Ops"\n',
    )
  })

  test("reads one session metadata by id from a directory", async () => {
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

    await writeSessionStore({ ...base, id: "ses_lookup", title: "Lookup", metadata: { icon: "🧭" } } as any)

    const session = await readSessionStore(directory, "ses_lookup" as any)
    expect(String(session?.id)).toBe("ses_lookup")
    expect(session?.title).toBe("Lookup")
    expect(session?.metadata).toEqual({ icon: "🧭" })
    expect(await readSessionStore(directory, "ses_missing" as any)).toBeUndefined()
  })

  test("overlays session metadata updates from session jsonl when meta is stale", async () => {
    const directory = await tempdir()
    const session = {
      id: "ses_jsonl_meta",
      slug: "jsonl-meta",
      version: "test",
      projectID: "proj_test",
      directory,
      path: ".",
      title: "Stale title",
      metadata: { icon: "🦊" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 1, updated: 2, archived: 3 },
    } as any

    await writeSessionStore(session)
    await appendSessionJsonl(session, {
      type: "session.updated.1",
      patch: { title: "JSONL title", metadata: { icon: "🧭" } },
    })
    await appendSessionJsonl(session, {
      type: "session.updated",
      patch: { permission: [{ permission: "bash", pattern: "*", action: "allow" }] },
    })
    await appendSessionJsonl(session, {
      type: "session.updated",
      patch: {
        workspaceID: "workspace-jsonl",
        share: { url: "https://example.com/share" },
        summary: { additions: 1, deletions: 2, files: 3, diffs: [] },
        revert: { messageID: "msg_jsonl_revert", partID: "prt_jsonl_revert" },
        time: { compacting: 12 },
      },
    })
    await appendSessionJsonl(session, {
      type: "session.updated",
      patch: { time: { archived: null } },
    })

    const restored = await readSessionStore(directory, "ses_jsonl_meta" as any)
    expect(restored?.title).toBe("JSONL title")
    expect(restored?.metadata).toEqual({ icon: "🧭" })
    expect(restored?.permission).toEqual([{ permission: "bash", pattern: "*", action: "allow" }])
    expect(restored?.workspaceID).toBe("workspace-jsonl" as any)
    expect(restored?.share).toEqual({ url: "https://example.com/share" })
    expect(restored?.summary).toEqual({ additions: 1, deletions: 2, files: 3, diffs: [] })
    expect(restored?.revert).toEqual({ messageID: "msg_jsonl_revert", partID: "prt_jsonl_revert" } as any)
    expect(restored?.time.compacting).toBe(12)
    expect(restored?.time.archived).toBeUndefined()
    expect(restored?.time.updated).toBeGreaterThan(2)
  })

  test("rebuilds session metadata from session.created when meta.yaml is missing", async () => {
    const directory = await tempdir()
    const session = {
      id: "ses_jsonl_created",
      slug: "jsonl-created",
      version: "test",
      projectID: "proj_test",
      directory: "/stale/source",
      path: ".",
      title: "Created from JSONL",
      metadata: { icon: "🌲" },
      cost: 1,
      tokens: { input: 2, output: 3, reasoning: 4, cache: { read: 5, write: 6 } },
      time: { created: 10, updated: 11, archived: 12 },
    } as any

    await appendSessionJsonl({ ...session, directory }, {
      type: "session.created",
      sessionID: "ses_jsonl_created",
      info: session,
    })
    await appendSessionJsonl({ ...session, directory }, {
      type: "session.updated",
      sessionID: "ses_jsonl_created",
      patch: { title: "Updated from JSONL", time: { archived: null } },
    })

    const restored = await readSessionStore(directory, "ses_jsonl_created" as any)
    expect(restored).toMatchObject({
      id: "ses_jsonl_created",
      slug: "jsonl-created",
      projectID: "proj_test",
      directory,
      title: "Updated from JSONL",
      metadata: { icon: "🌲" },
      cost: 1,
      tokens: { input: 2, output: 3, reasoning: 4, cache: { read: 5, write: 6 } },
    })
    expect(restored?.time.created).toBe(10)
    expect(restored?.time.archived).toBeUndefined()

    const sessions = await readSessionStores(directory)
    expect(sessions.map((item) => item.id)).toEqual(["ses_jsonl_created" as any])
  })

  test("sorts directory sessions using session jsonl metadata update time", async () => {
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
    const old = { ...base, id: "ses_jsonl_sort_old", title: "Old" } as any
    const fresh = { ...base, id: "ses_jsonl_sort_fresh", title: "Fresh", time: { created: 1, updated: 2 } } as any

    await writeSessionStore(old)
    await writeSessionStore(fresh)
    await appendSessionJsonl(old, { type: "session.updated", patch: { title: "Old updated" } })

    const sessions = await readSessionStores(directory)
    expect(sessions.map((session) => String(session.id))).toEqual(["ses_jsonl_sort_old", "ses_jsonl_sort_fresh"])
    expect(sessions[0]?.title).toBe("Old updated")
  })

  test("finds a session metadata store under a nested atree root", async () => {
    const root = await tempdir()
    const node = path.join(root, "projects", "alpha")
    await fs.mkdir(node, { recursive: true })
    await fs.mkdir(path.join(root, "node_modules", "ignored"), { recursive: true })

    await writeSessionStore({
      id: "ses_nested_lookup",
      slug: "nested-lookup",
      version: "test",
      projectID: "proj_test",
      directory: node,
      path: "projects/alpha",
      title: "Nested lookup",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 1, updated: 2 },
    } as any)

    const found = await findSessionStore(root, "ses_nested_lookup" as any)
    expect(found?.directory).toBe(await fs.realpath(node))
    expect(found?.title).toBe("Nested lookup")
    expect(await findSessionStore(root, "ses_missing" as any)).toBeUndefined()
  })

  test("treats the containing directory as authoritative when a session store is copied", async () => {
    const source = await tempdir()
    const target = await tempdir()
    const base = {
      id: "ses_copied",
      slug: "copied",
      version: "test",
      projectID: "proj_test",
      directory: source,
      path: ".",
      title: "Copied session",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 1, updated: 1 },
    }

    await writeSessionStore(base as any)
    await fs.cp(path.join(source, ".agents"), path.join(target, ".agents"), { recursive: true })

    const copied = await readSessionStore(target, "ses_copied" as any)
    expect(copied?.directory).toBe(target)

    const sessions = await readSessionStores(target)
    expect(sessions).toHaveLength(1)
    expect(sessions[0]?.directory).toBe(target)
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

  test("materializes data-url file parts into session assets", async () => {
    const directory = await tempdir()
    const session = {
      id: "ses_asset",
      slug: "ses-asset",
      version: "test",
      projectID: "proj_test",
      directory,
      title: "Asset",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 1, updated: 1 },
    } as any

    await writeSessionStore(session)
    await appendSessionJsonl(session, {
      type: "message.updated",
      message: { id: "msg_asset", sessionID: "ses_asset", role: "user", time: { created: 1 } },
    })
    await appendSessionJsonl(session, {
      type: "message.part.updated",
      part: {
        id: "prt_asset",
        sessionID: "ses_asset",
        messageID: "msg_asset",
        type: "file",
        mime: "image/png",
        filename: "image.png",
        url: "data:image/png;base64,Zm9v",
      },
    })

    const raw = await fs.readFile(
      path.join(directory, ".agents", "atree", "sessions", "ses_asset", "session.jsonl"),
      "utf8",
    )
    const lines = raw
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    const line = lines[1]
    expect(line.assets).toHaveLength(1)
    expect(line.assets[0]).toMatchObject({
      partID: "prt_asset",
      messageID: "msg_asset",
      filename: "image.png",
      mime: "image/png",
      size: 3,
    })
    expect(line.assets[0].path).toStartWith("assets/prt_asset-")
    expect(line.part.url).toBe(line.assets[0].path)
    expect(raw).not.toContain("data:image/png;base64")

    const asset = await fs.readFile(
      path.join(directory, ".agents", "atree", "sessions", "ses_asset", line.assets[0].path),
    )
    expect(asset.toString("utf8")).toBe("foo")

    const messages = await readSessionJsonlMessages(session)
    expect(messages[0]?.parts[0]).toMatchObject({
      id: "prt_asset",
      type: "file",
      url: "data:image/png;base64,Zm9v",
    })
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

  test("replays versioned session.jsonl message events", async () => {
    const directory = await tempdir()
    const session = {
      id: "ses_replay_versioned",
      slug: "ses-replay-versioned",
      version: "test",
      projectID: "proj_test",
      directory,
      title: "Replay versioned",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 1, updated: 1 },
    } as any

    await writeSessionStore(session)
    await appendSessionJsonl(session, {
      type: "message.updated.1",
      message: { id: "msg_versioned", sessionID: "ses_replay_versioned", role: "user", time: { created: 1 } },
    })
    await appendSessionJsonl(session, {
      type: "message.part.updated.1",
      part: {
        id: "prt_versioned",
        sessionID: "ses_replay_versioned",
        messageID: "msg_versioned",
        type: "text",
        text: "hello",
      },
    })
    await appendSessionJsonl(session, {
      type: "message.part.delta.1",
      sessionID: "ses_replay_versioned",
      messageID: "msg_versioned",
      partID: "prt_versioned",
      field: "text",
      delta: " versioned",
    })

    const messages = await readSessionJsonlMessages(session)
    expect(messages).toHaveLength(1)
    expect(messages[0]?.parts[0]).toMatchObject({ id: "prt_versioned", type: "text", text: "hello versioned" })
  })

  test("lets later updates clear message and part removal tombstones", async () => {
    const directory = await tempdir()
    const session = {
      id: "ses_replay_tombstone",
      slug: "ses-replay-tombstone",
      version: "test",
      projectID: "proj_test",
      directory,
      title: "Replay tombstone",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 1, updated: 1 },
    } as any

    await writeSessionStore(session)
    await appendSessionJsonl(session, { type: "message.removed", messageID: "msg_recreated" })
    await appendSessionJsonl(session, {
      type: "message.updated",
      message: { id: "msg_recreated", sessionID: "ses_replay_tombstone", role: "user", time: { created: 1 } },
    })
    await appendSessionJsonl(session, {
      type: "message.part.updated",
      part: {
        id: "prt_recreated",
        sessionID: "ses_replay_tombstone",
        messageID: "msg_recreated",
        type: "text",
        text: "first",
      },
    })
    await appendSessionJsonl(session, { type: "message.part.removed", messageID: "msg_recreated", partID: "prt_recreated" })
    await appendSessionJsonl(session, {
      type: "message.part.updated",
      part: {
        id: "prt_recreated",
        sessionID: "ses_replay_tombstone",
        messageID: "msg_recreated",
        type: "text",
        text: "second",
      },
    })

    const projection = await readSessionJsonlProjection(session)
    expect(projection.removedMessageIDs.has("msg_recreated")).toBe(false)
    expect(projection.removedPartIDs.has("msg_recreated:prt_recreated")).toBe(false)
    expect(projection.messages[0]?.parts[0]).toMatchObject({ id: "prt_recreated", text: "second" })
  })
})
