import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { readSessionTodoProjection, readSessionTodoState, writeSessionTodoState } from "../../src/atree/todo-store"

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
    expect(await readSessionTodoProjection(directory, "ses_empty")).toEqual({ hasState: true, todos: [] })
    expect(await readSessionTodoProjection(directory, "ses_missing")).toEqual({ hasState: false, todos: [] })
  })

  test("falls back to legacy directory todo state until the session is rewritten", async () => {
    const directory = await tempdir()
    const todo = { content: "legacy todo", status: "pending", priority: "medium" }

    await fs.mkdir(path.join(directory, ".agents", "atree", "extensions", "todo"), { recursive: true })
    await fs.writeFile(
      path.join(directory, ".agents", "atree", "extensions", "todo", "state.json"),
      JSON.stringify({ version: 1, updatedAt: 1, sessions: { ses_legacy: [todo] } }),
    )

    expect(await readSessionTodoState(directory, "ses_legacy")).toEqual([todo])
    await writeSessionTodoState(directory, "ses_legacy", [])
    expect(await readSessionTodoProjection(directory, "ses_legacy")).toEqual({ hasState: true, todos: [] })
    expect((await readLegacyState(directory)).sessions.ses_legacy).toBeUndefined()
  })
})
