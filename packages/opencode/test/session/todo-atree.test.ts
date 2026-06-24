import { describe, expect } from "bun:test"
import { randomUUID } from "crypto"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { Database } from "@opencode-ai/core/database/database"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { SessionTable, TodoTable } from "@opencode-ai/core/session/sql"
import { eq } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { readSessionTodoState, writeSessionTodoState } from "../../src/atree/todo-store"
import { readSessionStore, writeSessionStore } from "../../src/atree/session-store"
import { writeWorkspaceRoot } from "../../src/atree/state"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Session } from "../../src/session/session"
import { type SessionID } from "../../src/session/schema"
import { Todo } from "../../src/session/todo"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(Todo.defaultLayer, Session.defaultLayer, Database.defaultLayer, EventV2Bridge.defaultLayer))

describe("atree todo state", () => {
  it.instance("writes todo updates to directory state", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const todo = yield* Todo.Service
      const instance = yield* TestInstance
      const session = yield* sessions.create({ title: "todo-state" })

      yield* todo.update({
        sessionID: session.id,
        todos: [{ content: "write todo state", status: "pending", priority: "high" }],
      })

      expect(yield* Effect.promise(() => readSessionTodoState(instance.directory, session.id))).toEqual([
        { content: "write todo state", status: "pending", priority: "high" },
      ])
    }),
  )

  it.instance("records todo updates before refreshing the directory projection", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const todo = yield* Todo.Service
      const instance = yield* TestInstance
      const session = yield* sessions.create({ title: "todo-event-first" })

      yield* todo.update({
        sessionID: session.id,
        todos: [{ content: "event before projection", status: "pending", priority: "medium" }],
      })

      const raw = yield* Effect.promise(() =>
        fs.readFile(path.join(instance.directory, ".agents", "atree", "sessions", session.id, "session.jsonl"), "utf8"),
      )
      const todoEvent = raw
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .find((entry) => entry.type === "todo.updated")
      const stored = yield* Effect.promise(() => readSessionStore(instance.directory, session.id))

      expect(todoEvent).toMatchObject({
        type: "todo.updated",
        sessionID: session.id,
        todos: [{ content: "event before projection", status: "pending", priority: "medium" }],
      })
      expect(typeof todoEvent?.at).toBe("number")
      expect(stored?.time.updated).toBeGreaterThanOrEqual(todoEvent?.at as number)
    }),
  )

  it.instance("prefers directory todo state over stale database rows", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const todo = yield* Todo.Service
      const instance = yield* TestInstance
      const { db } = yield* Database.Service
      const session = yield* sessions.create({ title: "todo-directory-priority" })

      yield* todo.update({
        sessionID: session.id,
        todos: [{ content: "stale database todo", status: "pending", priority: "low" }],
      })
      yield* db
        .insert(TodoTable)
        .values({
          session_id: session.id,
          content: "stale database todo",
          status: "pending",
          priority: "low",
          position: 0,
        })
        .run()
        .pipe(Effect.orDie)
      yield* Effect.promise(() => writeSessionTodoState(instance.directory, session.id, []))

      const rows = yield* db
        .select()
        .from(TodoTable)
        .where(eq(TodoTable.session_id, session.id))
        .all()
        .pipe(Effect.orDie)
      expect(rows).toHaveLength(1)
      expect(yield* todo.get(session.id)).toEqual([])
    }),
  )

  it.instance("does not revive stale database todos when a directory session has no todo state", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const todo = yield* Todo.Service
      const { db } = yield* Database.Service
      const session = yield* sessions.create({ title: "todo-missing-state-priority" })

      yield* db
        .insert(TodoTable)
        .values({
          session_id: session.id,
          content: "stale database todo without directory state",
          status: "pending",
          priority: "low",
          position: 0,
        })
        .run()
        .pipe(Effect.orDie)

      expect(yield* todo.get(session.id)).toEqual([])
    }),
  )

  it.instance("does not read explicit directory todos from stale database rows", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const todo = yield* Todo.Service
      const instance = yield* TestInstance
      const { db } = yield* Database.Service
      const session = yield* sessions.create({ title: "todo-cached-only" })

      yield* todo.update({
        sessionID: session.id,
        todos: [{ content: "stale explicit todo", status: "pending", priority: "low" }],
      })
      yield* db
        .insert(TodoTable)
        .values({
          session_id: session.id,
          content: "stale explicit todo",
          status: "pending",
          priority: "low",
          position: 0,
        })
        .run()
        .pipe(Effect.orDie)
      yield* Effect.promise(() =>
        fs.rm(path.join(instance.directory, ".agents", "atree", "sessions", session.id), {
          recursive: true,
          force: true,
        }),
      )

      const rows = yield* db
        .select()
        .from(TodoTable)
        .where(eq(TodoTable.session_id, session.id))
        .all()
        .pipe(Effect.orDie)
      expect(rows).toHaveLength(1)
      expect(yield* todo.get(session.id, { directory: instance.directory })).toEqual([])
    }),
  )

  it.instance("does not read or write unscoped todos for a missing file-backed session", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const todo = yield* Todo.Service
      const instance = yield* TestInstance
      const { db } = yield* Database.Service
      const session = yield* sessions.create({ title: "todo-unscoped-cached-only" })

      yield* db
        .insert(TodoTable)
        .values({
          session_id: session.id,
          content: "stale unscoped todo",
          status: "pending",
          priority: "low",
          position: 0,
        })
        .run()
        .pipe(Effect.orDie)
      yield* Effect.promise(() =>
        fs.rm(path.join(instance.directory, ".agents", "atree", "sessions", session.id), {
          recursive: true,
          force: true,
        }),
      )

      expect(yield* todo.get(session.id)).toEqual([])
      yield* todo.update({
        sessionID: session.id,
        todos: [{ content: "should not be written", status: "pending", priority: "high" }],
      })

      const rows = yield* db
        .select()
        .from(TodoTable)
        .where(eq(TodoTable.session_id, session.id))
        .all()
        .pipe(Effect.orDie)
      expect(rows).toEqual([
        expect.objectContaining({
          content: "stale unscoped todo",
          status: "pending",
          priority: "low",
        }),
      ])
    }),
  )

  it.instance("reads todo state for a file-backed session without a database row", () =>
    Effect.gen(function* () {
      const todo = yield* Todo.Service
      const instance = yield* TestInstance
      const sessionID = "ses_file_todo" as SessionID
      const now = Date.now()

      yield* Effect.promise(() =>
        writeSessionStore({
          id: sessionID,
          slug: "file-todo",
          version: "test",
          projectID: "proj_file",
          directory: instance.directory,
          path: ".",
          title: "File todo",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: now, updated: now },
        } as any),
      )
      yield* Effect.promise(() =>
        writeSessionTodoState(instance.directory, sessionID, [
          { content: "restore file todo", status: "in_progress", priority: "medium" },
        ]),
      )

      expect(yield* todo.get(sessionID)).toEqual([
        { content: "restore file todo", status: "in_progress", priority: "medium" },
      ])
    }),
  )

  it.effect("reads todo state from an explicit directory without an instance context", () =>
    Effect.gen(function* () {
      const todo = yield* Todo.Service
      const directory = yield* Effect.acquireRelease(
        Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "atree-todo-explicit-"))),
        (dir) => Effect.promise(() => fs.rm(dir, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      const sessionID = "ses_explicit_todo" as SessionID
      const now = Date.now()

      yield* Effect.promise(() =>
        writeSessionStore({
          id: sessionID,
          slug: "explicit-todo",
          version: "test",
          projectID: "proj_file",
          directory,
          path: ".",
          title: "Explicit todo",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: now, updated: now },
        } as any),
      )
      yield* Effect.promise(() =>
        writeSessionTodoState(directory, sessionID, [
          { content: "restore explicit todo", status: "pending", priority: "high" },
        ]),
      )

      expect(yield* todo.get(sessionID, { directory })).toEqual([
        { content: "restore explicit todo", status: "pending", priority: "high" },
      ])
    }),
  )

  it.effect("updates todo state for an explicit directory without writing database todo rows", () =>
    Effect.gen(function* () {
      const todo = yield* Todo.Service
      const directory = yield* Effect.acquireRelease(
        Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "atree-todo-update-"))),
        (dir) => Effect.promise(() => fs.rm(dir, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      const sessionID = "ses_explicit_todo_update" as SessionID
      const now = Date.now()

      yield* Effect.promise(() =>
        writeSessionStore({
          id: sessionID,
          slug: "explicit-todo-update",
          version: "test",
          projectID: "proj_file",
          directory,
          path: ".",
          title: "Explicit todo update",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: now, updated: now },
        } as any),
      )

      yield* todo.update({
        sessionID,
        directory,
        todos: [{ content: "write explicit todo", status: "in_progress", priority: "medium" }],
      })

      expect(yield* Effect.promise(() => readSessionTodoState(directory, sessionID))).toEqual([
        { content: "write explicit todo", status: "in_progress", priority: "medium" },
      ])
      const dbRows = yield* Database.Service.use(({ db }) =>
        db.select().from(TodoTable).where(eq(TodoTable.session_id, sessionID)).all().pipe(Effect.orDie),
      )
      expect(dbRows).toEqual([])
    }),
  )

  it.effect("does not rewrite a stale database session row when updating explicit directory todos", () =>
    Effect.gen(function* () {
      const todo = yield* Todo.Service
      const source = yield* Effect.acquireRelease(
        Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "atree-todo-stale-session-source-"))),
        (dir) => Effect.promise(() => fs.rm(dir, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      const target = yield* Effect.acquireRelease(
        Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "atree-todo-stale-session-target-"))),
        (dir) => Effect.promise(() => fs.rm(dir, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      const { db } = yield* Database.Service
      const suffix = randomUUID().replaceAll("-", "")
      const projectID = `proj_todo_stale_session_${suffix}`
      const sessionID = `ses_todo_stale_session_${suffix}` as SessionID
      const now = Date.now()

      yield* db
        .insert(ProjectTable)
        .values({
          id: projectID,
          worktree: source,
          vcs: null,
          name: null,
          time_created: now,
          time_updated: now,
          sandboxes: [],
        } as unknown as typeof ProjectTable.$inferInsert)
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: projectID,
          slug: "todo-stale-session",
          directory: source,
          title: "Todo stale session",
          version: "test",
          cost: 0,
          tokens_input: 0,
          tokens_output: 0,
          tokens_reasoning: 0,
          tokens_cache_read: 0,
          tokens_cache_write: 0,
          time_created: now,
          time_updated: now,
        } as typeof SessionTable.$inferInsert)
        .run()
        .pipe(Effect.orDie)
      yield* Effect.promise(() =>
        writeSessionStore({
          id: sessionID,
          slug: "todo-stale-session",
          version: "test",
          projectID: "proj_file",
          directory: target,
          path: ".",
          title: "Todo stale session",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: now, updated: now },
        } as any),
      )

      yield* todo.update({
        sessionID,
        directory: target,
        todos: [{ content: "write explicit todo", status: "in_progress", priority: "medium" }],
      })

      expect(yield* Effect.promise(() => readSessionTodoState(target, sessionID))).toEqual([
        { content: "write explicit todo", status: "in_progress", priority: "medium" },
      ])
      const dbRows = yield* db.select().from(TodoTable).where(eq(TodoTable.session_id, sessionID)).all().pipe(Effect.orDie)
      expect(dbRows).toEqual([])
      const sessionRow = yield* db
        .select()
        .from(SessionTable)
        .where(eq(SessionTable.id, sessionID))
        .get()
        .pipe(Effect.orDie)
      expect(sessionRow?.directory).toBe(source)
    }),
  )

  it.effect("does not write database todos for a missing explicit directory session", () =>
    Effect.gen(function* () {
      const todo = yield* Todo.Service
      const source = yield* Effect.acquireRelease(
        Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "atree-todo-missing-source-"))),
        (dir) => Effect.promise(() => fs.rm(dir, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      const target = yield* Effect.acquireRelease(
        Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "atree-todo-missing-target-"))),
        (dir) => Effect.promise(() => fs.rm(dir, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      const { db } = yield* Database.Service
      const suffix = randomUUID().replaceAll("-", "")
      const projectID = `proj_missing_explicit_todo_${suffix}`
      const sessionID = `ses_missing_explicit_todo_${suffix}` as SessionID
      const now = Date.now()

      yield* db
        .insert(ProjectTable)
        .values({
          id: projectID,
          worktree: source,
          vcs: null,
          name: null,
          time_created: now,
          time_updated: now,
          sandboxes: [],
        } as unknown as typeof ProjectTable.$inferInsert)
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: projectID,
          slug: "missing-explicit-todo",
          directory: source,
          title: "Missing explicit todo",
          version: "test",
          cost: 0,
          tokens_input: 0,
          tokens_output: 0,
          tokens_reasoning: 0,
          tokens_cache_read: 0,
          tokens_cache_write: 0,
          time_created: now,
          time_updated: now,
        } as typeof SessionTable.$inferInsert)
        .run()
        .pipe(Effect.orDie)

      yield* todo.update({
        sessionID,
        directory: target,
        todos: [{ content: "should not be written", status: "pending", priority: "high" }],
      })

      const rows = yield* db
        .select()
        .from(TodoTable)
        .where(eq(TodoTable.session_id, sessionID))
        .all()
        .pipe(Effect.orDie)
      expect(rows).toEqual([])
      expect(yield* Effect.promise(() => readSessionTodoState(target, sessionID))).toEqual([])
    }),
  )

  it.effect("restores todo state from session jsonl when todo projection files are removed", () =>
    Effect.gen(function* () {
      const todo = yield* Todo.Service
      const directory = yield* Effect.acquireRelease(
        Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "atree-todo-jsonl-"))),
        (dir) => Effect.promise(() => fs.rm(dir, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      const sessionID = "ses_todo_jsonl_restore" as SessionID
      const now = Date.now()

      yield* Effect.promise(() =>
        writeSessionStore({
          id: sessionID,
          slug: "todo-jsonl-restore",
          version: "test",
          projectID: "proj_file",
          directory,
          path: ".",
          title: "Todo JSONL restore",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: now, updated: now },
        } as any),
      )

      yield* todo.update({
        sessionID,
        directory,
        todos: [{ content: "restore from todo jsonl", status: "in_progress", priority: "high" }],
      })
      yield* Effect.promise(() =>
        fs.rm(path.join(directory, ".agents", "atree", "sessions", sessionID, "todo.json"), { force: true }),
      )
      yield* Database.Service.use(({ db }) =>
        db.delete(TodoTable).where(eq(TodoTable.session_id, sessionID)).run().pipe(Effect.orDie),
      )

      expect(yield* todo.get(sessionID, { directory })).toEqual([
        { content: "restore from todo jsonl", status: "in_progress", priority: "high" },
      ])
    }),
  )

  it.instance("updates todo state for a nested file-backed session found from the persisted atree root", () =>
    Effect.gen(function* () {
      const todo = yield* Todo.Service
      const instance = yield* TestInstance
      const data = yield* Effect.acquireRelease(
        Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "atree-todo-root-data-"))),
        (dir) => Effect.promise(() => fs.rm(dir, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      const previousData = Global.Path.data
      ;(Global.Path as { data: string }).data = data
      yield* Effect.addFinalizer(() => Effect.sync(() => ((Global.Path as { data: string }).data = previousData)))

      const sessionID = "ses_nested_todo_update" as SessionID
      const now = Date.now()
      const nodeDirectory = path.join(instance.directory, "nested", "todo-node")
      yield* Effect.promise(() => fs.mkdir(nodeDirectory, { recursive: true }))
      yield* Effect.promise(() => writeWorkspaceRoot(instance.directory))
      yield* Effect.promise(() =>
        writeSessionStore({
          id: sessionID,
          slug: "nested-todo-update",
          version: "test",
          projectID: "proj_file",
          directory: nodeDirectory,
          path: "nested/todo-node",
          title: "Nested todo update",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: now, updated: now },
        } as any),
      )

      yield* todo.update({
        sessionID,
        todos: [{ content: "write nested todo", status: "in_progress", priority: "high" }],
      })

      expect(yield* Effect.promise(() => readSessionTodoState(nodeDirectory, sessionID))).toEqual([
        { content: "write nested todo", status: "in_progress", priority: "high" },
      ])
    }),
  )

  it.effect("prefers newer todo jsonl events over a stale todo projection", () =>
    Effect.gen(function* () {
      const todo = yield* Todo.Service
      const directory = yield* Effect.acquireRelease(
        Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "atree-todo-stale-projection-"))),
        (dir) => Effect.promise(() => fs.rm(dir, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      const sessionID = "ses_todo_stale_projection" as SessionID
      const now = Date.now()
      const session = {
        id: sessionID,
        slug: "todo-stale-projection",
        version: "test",
        projectID: "proj_file",
        directory,
        path: ".",
        title: "Todo stale projection",
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: now, updated: now },
      } as any

      yield* Effect.promise(() => writeSessionStore(session))
      yield* Effect.promise(() =>
        writeSessionTodoState(directory, sessionID, [
          { content: "old projection todo", status: "pending", priority: "low" },
        ]),
      )
      yield* Effect.promise(() =>
        fs.appendFile(
          path.join(directory, ".agents", "atree", "sessions", sessionID, "session.jsonl"),
          `${JSON.stringify({
            version: 1,
            at: now + 10_000,
            type: "todo.updated",
            sessionID,
            todos: [{ content: "new jsonl todo", status: "in_progress", priority: "high" }],
          })}\n`,
        ),
      )

      expect(yield* todo.get(sessionID, { directory })).toEqual([
        { content: "new jsonl todo", status: "in_progress", priority: "high" },
      ])
    }),
  )

  it.effect("ignores a stale database directory when resolving todo state from the persisted atree root", () =>
    Effect.gen(function* () {
      const todo = yield* Todo.Service
      const { db } = yield* Database.Service
      const data = yield* Effect.acquireRelease(
        Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "atree-todo-stale-data-"))),
        (dir) => Effect.promise(() => fs.rm(dir, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "atree-todo-stale-root-"))),
        (dir) => Effect.promise(() => fs.rm(dir, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      const previousData = Global.Path.data
      ;(Global.Path as { data: string }).data = data
      yield* Effect.addFinalizer(() => Effect.sync(() => ((Global.Path as { data: string }).data = previousData)))

      const staleDirectory = path.join(root, "old")
      const actualDirectory = path.join(root, "new")
      const suffix = randomUUID().replaceAll("-", "")
      const projectID = `proj_stale_todo_${suffix}`
      const sessionID = `ses_stale_todo_directory_${suffix}` as SessionID
      const now = Date.now()
      yield* Effect.promise(() => fs.mkdir(staleDirectory, { recursive: true }))
      yield* Effect.promise(() => fs.mkdir(actualDirectory, { recursive: true }))
      yield* Effect.promise(() => writeWorkspaceRoot(root))
      yield* db
        .insert(ProjectTable)
        .values({
          id: projectID,
          worktree: staleDirectory,
          vcs: null,
          name: null,
          time_created: now,
          time_updated: now,
          sandboxes: [],
        } as unknown as typeof ProjectTable.$inferInsert)
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: projectID,
          slug: "stale-todo-directory",
          directory: staleDirectory,
          title: "Stale todo directory",
          version: "test",
          cost: 0,
          tokens_input: 0,
          tokens_output: 0,
          tokens_reasoning: 0,
          tokens_cache_read: 0,
          tokens_cache_write: 0,
          time_created: now,
          time_updated: now,
        } as typeof SessionTable.$inferInsert)
        .run()
        .pipe(Effect.orDie)
      yield* Effect.promise(() =>
        writeSessionStore({
          id: sessionID,
          slug: "actual-todo-directory",
          version: "test",
          projectID: "proj_actual_todo",
          directory: actualDirectory,
          path: "new",
          title: "Actual todo directory",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: now, updated: now },
        } as any),
      )

      yield* todo.update({
        sessionID,
        todos: [{ content: "write to actual todo directory", status: "pending", priority: "high" }],
      })

      expect(yield* Effect.promise(() => readSessionTodoState(actualDirectory, sessionID))).toEqual([
        { content: "write to actual todo directory", status: "pending", priority: "high" },
      ])
      expect(yield* Effect.promise(() => readSessionTodoState(staleDirectory, sessionID))).toEqual([])
    }),
  )

  it.instance("writes copied file-backed todo state to the explicit target directory", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const todo = yield* Todo.Service
      const source = yield* TestInstance
      const target = yield* Effect.acquireRelease(
        Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "atree-todo-copy-target-"))),
        (dir) => Effect.promise(() => fs.rm(dir, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      const session = yield* sessions.create({ title: "copied-todo" })
      const events = yield* EventV2Bridge.Service
      const eventDirectories: string[] = []
      const off = yield* events.listen((event) => {
        if (event.type === Todo.Event.Updated.type) eventDirectories.push(event.location?.directory ?? "")
        return Effect.void
      })
      yield* Effect.addFinalizer(() => off)

      yield* Effect.promise(() =>
        writeSessionTodoState(source.directory, session.id, [
          { content: "source todo", status: "pending", priority: "low" },
        ]),
      )
      yield* Effect.promise(() =>
        fs.cp(path.join(source.directory, ".agents"), path.join(target, ".agents"), { recursive: true }),
      )

      yield* todo.update({
        sessionID: session.id,
        directory: target,
        todos: [{ content: "target todo", status: "in_progress", priority: "high" }],
      })

      expect(yield* Effect.promise(() => readSessionTodoState(target, session.id))).toEqual([
        { content: "target todo", status: "in_progress", priority: "high" },
      ])
      expect(yield* Effect.promise(() => readSessionTodoState(source.directory, session.id))).toEqual([
        { content: "source todo", status: "pending", priority: "low" },
      ])
      expect(eventDirectories).toEqual([target])
    }),
  )

  it.instance("clears copied file-backed todo state only in the explicit target directory", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const todo = yield* Todo.Service
      const source = yield* TestInstance
      const target = yield* Effect.acquireRelease(
        Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "atree-todo-copy-clear-target-"))),
        (dir) => Effect.promise(() => fs.rm(dir, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      const session = yield* sessions.create({ title: "copied-todo-clear" })

      yield* Effect.promise(() =>
        writeSessionTodoState(source.directory, session.id, [
          { content: "source todo survives clear", status: "pending", priority: "low" },
        ]),
      )
      yield* Effect.promise(() =>
        fs.cp(path.join(source.directory, ".agents"), path.join(target, ".agents"), { recursive: true }),
      )
      yield* Effect.promise(() =>
        writeSessionTodoState(target, session.id, [
          { content: "target todo clears", status: "in_progress", priority: "high" },
        ]),
      )

      yield* todo.update({
        sessionID: session.id,
        directory: target,
        todos: [],
      })

      expect(yield* Effect.promise(() => readSessionTodoState(target, session.id))).toEqual([])
      expect(yield* Effect.promise(() => readSessionTodoState(source.directory, session.id))).toEqual([
        { content: "source todo survives clear", status: "pending", priority: "low" },
      ])
      expect(yield* todo.get(session.id, { directory: target })).toEqual([])
      expect(yield* todo.get(session.id, { directory: source.directory })).toEqual([
        { content: "source todo survives clear", status: "pending", priority: "low" },
      ])
    }),
  )

  it.effect("does not revive persisted-root todos when the session store was removed", () =>
    Effect.gen(function* () {
      const todo = yield* Todo.Service
      const { db } = yield* Database.Service
      const data = yield* Effect.acquireRelease(
        Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "atree-todo-root-missing-data-"))),
        (dir) => Effect.promise(() => fs.rm(dir, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "atree-todo-root-missing-"))),
        (dir) => Effect.promise(() => fs.rm(dir, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      const previousData = Global.Path.data
      ;(Global.Path as { data: string }).data = data
      yield* Effect.addFinalizer(() => Effect.sync(() => ((Global.Path as { data: string }).data = previousData)))

      const node = path.join(root, "node")
      const suffix = randomUUID().replaceAll("-", "")
      const sessionID = `ses_todo_root_missing_${suffix}` as SessionID
      const projectID = `proj_todo_root_missing_${suffix}`
      const now = Date.now()
      yield* Effect.promise(() => fs.mkdir(node, { recursive: true }))
      yield* Effect.promise(() => writeWorkspaceRoot(root))
      yield* db
        .insert(ProjectTable)
        .values({
          id: projectID,
          worktree: node,
          vcs: null,
          name: null,
          time_created: now,
          time_updated: now,
          sandboxes: [],
        } as unknown as typeof ProjectTable.$inferInsert)
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: projectID,
          slug: "todo-root-missing",
          directory: node,
          title: "Todo root missing",
          version: "test",
          cost: 0,
          tokens_input: 0,
          tokens_output: 0,
          tokens_reasoning: 0,
          tokens_cache_read: 0,
          tokens_cache_write: 0,
          time_created: now,
          time_updated: now,
        } as typeof SessionTable.$inferInsert)
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(TodoTable)
        .values({
          session_id: sessionID,
          content: "stale opencode database todo",
          status: "pending",
          priority: "low",
          position: 0,
        })
        .run()
        .pipe(Effect.orDie)
      yield* Effect.promise(() =>
        writeSessionStore({
          id: sessionID,
          slug: "todo-root-missing",
          version: "test",
          projectID,
          directory: node,
          path: "node",
          title: "Todo root missing",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: now, updated: now },
        } as any),
      )
      yield* Effect.promise(() =>
        fs.rm(path.join(node, ".agents", "atree", "sessions", sessionID), { recursive: true, force: true }),
      )

      expect(yield* todo.get(sessionID)).toEqual([])
    }),
  )
})
