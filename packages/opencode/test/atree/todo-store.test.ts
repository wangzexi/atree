import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { readSessionTodoProjection, readSessionTodoState, writeSessionTodoState } from "../../src/atree/todo-store"
import { appendSessionJsonl, readSessionStore, writeSessionStore } from "../../src/atree/session-store"

const temps: string[] = []

async function tempdir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "atree-todo-store-"))
  temps.push(dir)
  return dir
}

async function readState(directory: string) {
  return JSON.parse(
    await fs.readFile(path.join(directory, ".agents", "atree", "sessions", "ses_two", "todo.json"), "utf8"),
  ) as {
    version: 1
    todos: unknown[]
  }
}

async function readLegacyState(directory: string) {
  return JSON.parse(
    await fs.readFile(path.join(directory, ".agents", "atree", "extensions", "todo", "state.json"), "utf8"),
  ) as {
    version: 1
    sessions: Record<string, unknown[]>
  }
}

afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

describe("atree todo store", () => {
  test("updates one session todo entry without removing others", async () => {
    const directory = await tempdir()
    const todo = { content: "ship atree", status: "pending", priority: "high" }

    await writeSessionTodoState(directory, "ses_one", [todo])
    await writeSessionTodoState(directory, "ses_two", [{ ...todo, content: "keep other session" }])
    await writeSessionTodoState(directory, "ses_one", [])

    const meta = await fs.readFile(path.join(directory, ".agents", "atree", "meta.yaml"), "utf8")
    const state = await readState(directory)
    expect(meta).toContain("version: 1")
    expect(meta).toContain('source: "atree"')
    expect(state.version).toBe(1)
    expect(await readSessionTodoState(directory, "ses_one")).toEqual([])
    expect(state.todos).toHaveLength(1)
    expect(state.todos[0]).toMatchObject({ content: "keep other session" })
  })

  test("distinguishes missing todo state from an explicitly empty todo list", async () => {
    const directory = await tempdir()
    await writeSessionTodoState(directory, "ses_empty", [])

    expect(await readSessionTodoState(directory, "ses_empty")).toEqual([])
    expect(await readSessionTodoProjection(directory, "ses_empty")).toMatchObject({ hasState: true, todos: [] })
    expect(await readSessionTodoProjection(directory, "ses_missing")).toMatchObject({ hasState: false, todos: [] })
    expect(await readSessionTodoProjection(directory, "ses_empty")).not.toHaveProperty("updatedAt")
  })

  test("creates the session payload skeleton when writing todo state", async () => {
    const directory = await tempdir()
    await writeSessionTodoState(directory, "ses_skeleton", [])

    const root = path.join(directory, ".agents", "atree", "sessions", "ses_skeleton")
    expect((await fs.readFile(path.join(root, "session.jsonl"), "utf8")).trim()).toContain('"type":"todo.updated"')
    expect((await fs.stat(path.join(root, "assets"))).isDirectory()).toBe(true)
    expect(JSON.parse(await fs.readFile(path.join(root, "todo.json"), "utf8"))).toMatchObject({
      version: 1,
      todos: [],
    })
  })

  test("touches session metadata when writing todo state", async () => {
    const directory = await tempdir()
    await writeSessionStore({
      id: "ses_touch" as never,
      slug: "touch",
      version: "test",
      projectID: "proj_touch" as never,
      directory,
      title: "Touch",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 10, updated: 20 },
    })

    await writeSessionTodoState(directory, "ses_touch", [])

    expect((await readSessionStore(directory, "ses_touch" as never))?.time.updated).toBeGreaterThan(20)
  })

  test("does not read legacy directory todo state as session state", async () => {
    const directory = await tempdir()
    const todo = { content: "legacy todo", status: "pending", priority: "medium" }

    await fs.mkdir(path.join(directory, ".agents", "atree", "extensions", "todo"), { recursive: true })
    await fs.writeFile(
      path.join(directory, ".agents", "atree", "extensions", "todo", "state.json"),
      JSON.stringify({ version: 1, updatedAt: 1, sessions: { ses_legacy: [todo] } }),
    )

    expect(await readSessionTodoProjection(directory, "ses_legacy")).toEqual({ hasState: false, todos: [] })
    expect(await readSessionTodoState(directory, "ses_legacy")).toEqual([])
    await writeSessionTodoState(directory, "ses_legacy", [])
    expect(await readSessionTodoProjection(directory, "ses_legacy")).toMatchObject({ hasState: true, todos: [] })
    expect((await readLegacyState(directory)).sessions.ses_legacy).toBeUndefined()
  })

  test("replays todo state from session jsonl when the projection file is missing", async () => {
    const directory = await tempdir()
    await writeSessionStore({
      id: "ses_jsonl" as never,
      slug: "jsonl",
      version: "test",
      projectID: "proj_jsonl" as never,
      directory,
      title: "JSONL",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 1, updated: 1 },
    })
    const session = (await readSessionStore(directory, "ses_jsonl" as never))!
    await appendSessionJsonl(session, {
      type: "todo.updated",
      sessionID: "ses_jsonl",
      todos: [{ content: "old todo", status: "pending", priority: "low" }],
    })
    await appendSessionJsonl(session, {
      type: "todo.updated",
      sessionID: "ses_jsonl",
      todos: [{ content: "restored todo", status: "in_progress", priority: "high" }],
    })

    expect(await readSessionTodoProjection(directory, "ses_jsonl")).toMatchObject({
      hasState: true,
      todos: [{ content: "restored todo", status: "in_progress", priority: "high" }],
    })
    expect(await readSessionTodoState(directory, "ses_jsonl")).toEqual([
      { content: "restored todo", status: "in_progress", priority: "high" },
    ])
  })

  test("prefers session jsonl todo state over a newer projection file", async () => {
    const directory = await tempdir()
    const sessionID = "ses_jsonl_authoritative"
    await writeSessionStore({
      id: sessionID as never,
      slug: "jsonl-authoritative",
      version: "test",
      projectID: "proj_jsonl_authoritative" as never,
      directory,
      title: "JSONL authoritative",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 1, updated: 1 },
    })
    await writeSessionTodoState(directory, sessionID, [
      { content: "projection todo", status: "pending", priority: "low" },
    ])
    const session = (await readSessionStore(directory, sessionID as never))!
    await appendSessionJsonl(session, {
      type: "todo.updated",
      at: 1,
      sessionID,
      todos: [{ content: "jsonl todo", status: "in_progress", priority: "high" }],
    })

    expect(await readSessionTodoState(directory, sessionID)).toEqual([
      { content: "jsonl todo", status: "in_progress", priority: "high" },
    ])
  })

  test("replays an explicitly empty todo list from session jsonl", async () => {
    const directory = await tempdir()
    await writeSessionStore({
      id: "ses_jsonl_empty" as never,
      slug: "jsonl-empty",
      version: "test",
      projectID: "proj_jsonl_empty" as never,
      directory,
      title: "JSONL empty",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 1, updated: 1 },
    })
    const session = (await readSessionStore(directory, "ses_jsonl_empty" as never))!
    await appendSessionJsonl(session, {
      type: "todo.updated",
      sessionID: "ses_jsonl_empty",
      todos: [],
    })

    expect(await readSessionTodoProjection(directory, "ses_jsonl_empty")).toMatchObject({ hasState: true, todos: [] })
    expect(await readSessionTodoProjection(directory, "ses_missing")).toMatchObject({ hasState: false, todos: [] })
  })

  test("replays versioned todo events from session jsonl", async () => {
    const directory = await tempdir()
    await writeSessionStore({
      id: "ses_jsonl_versioned" as never,
      slug: "jsonl-versioned",
      version: "test",
      projectID: "proj_jsonl_versioned" as never,
      directory,
      title: "JSONL versioned",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 1, updated: 1 },
    })
    const session = (await readSessionStore(directory, "ses_jsonl_versioned" as never))!
    await appendSessionJsonl(session, {
      type: "todo.updated.1",
      sessionID: "ses_jsonl_versioned",
      todos: [{ content: "versioned todo", status: "pending", priority: "medium" }],
    })

    expect(await readSessionTodoProjection(directory, "ses_jsonl_versioned")).toMatchObject({
      hasState: true,
      todos: [{ content: "versioned todo", status: "pending", priority: "medium" }],
    })
  })

  test("replays nested todo event data from session jsonl", async () => {
    const directory = await tempdir()
    await writeSessionStore({
      id: "ses_jsonl_nested" as never,
      slug: "jsonl-nested",
      version: "test",
      projectID: "proj_jsonl_nested" as never,
      directory,
      title: "JSONL nested",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 1, updated: 1 },
    })
    const session = (await readSessionStore(directory, "ses_jsonl_nested" as never))!
    await appendSessionJsonl(session, {
      type: "todo.updated",
      at: 10,
      data: {
        sessionID: "ses_jsonl_nested",
        todos: [{ content: "nested todo", status: "pending", priority: "medium" }],
      },
    })

    expect(await readSessionTodoProjection(directory, "ses_jsonl_nested")).toMatchObject({
      hasState: true,
      todos: [{ content: "nested todo", status: "pending", priority: "medium" }],
    })
  })
})
