import { describe, expect } from "bun:test"
import { asc, eq } from "drizzle-orm"
import { DateTime, Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { Global } from "@opencode-ai/core/global"
import { appendSessionJsonl, readSessionStore, writeSessionStore } from "@opencode-ai/core/atree/session-store"
import { readSessionTodoProjection } from "@opencode-ai/core/atree/todo-store"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionTable, TodoTable } from "@opencode-ai/core/session/sql"
import { SessionTodo } from "@opencode-ai/core/session/todo"
import { testEffect } from "./lib/effect"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "fs/promises"
import os from "os"
import path from "path"

const database = Database.layerFromPath(":memory:")
const events = EventV2.layer.pipe(Layer.provide(database))
const todos = SessionTodo.layer.pipe(Layer.provide(database), Layer.provide(events))
const it = testEffect(Layer.mergeAll(database, events, todos))
const sessionID = SessionV2.ID.make("ses_todo_test")

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: Project.ID.global,
      slug: "todo",
      directory: "/project",
      title: "todo",
      version: "test",
    })
    .run()
    .pipe(Effect.orDie)
})

describe("SessionTodo", () => {
  it.effect("does not persist todos for SQLite-only sessions", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      const todos = yield* SessionTodo.Service
      const published = new Array<EventV2.Payload>()
      const unsubscribe = yield* events.listen((event) =>
        Effect.sync(() => {
          if (event.type === SessionTodo.Event.Updated.type) published.push(event)
        }),
      )
      yield* Effect.addFinalizer(() => unsubscribe)

      yield* todos.update({
        sessionID,
        todos: [
          { content: "second", status: "pending", priority: "low" },
          { content: "first", status: "in_progress", priority: "high" },
        ],
      })
      expect(yield* todos.get(sessionID)).toEqual([])
      expect(
        (yield* db.select().from(TodoTable).orderBy(asc(TodoTable.position)).all().pipe(Effect.orDie)).map((row) => ({
          content: row.content,
          position: row.position,
        })),
      ).toEqual([])

      yield* todos.update({ sessionID, todos: [{ content: "replacement", status: "completed", priority: "medium" }] })
      expect(yield* todos.get(sessionID)).toEqual([])

      yield* todos.update({ sessionID, todos: [] })
      expect(yield* todos.get(sessionID)).toEqual([])
      expect(published).toEqual([])
    }),
  )

  it.effect("mirrors todo state into a file-backed session directory", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "atree-core-todo-"))),
        (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      const { db } = yield* Database.Service
      const todos = yield* SessionTodo.Service
      const fileSessionID = SessionV2.ID.make("ses_core_file_todo_state")
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make(directory), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: fileSessionID,
          project_id: Project.ID.global,
          slug: "file-todo",
          directory,
          title: "file todo",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      yield* Effect.promise(() =>
        writeSessionStore({
          id: fileSessionID,
          projectID: Project.ID.global,
          title: "file todo",
          location: { directory: AbsolutePath.make(directory) },
          time: { created: DateTime.makeUnsafe(1), updated: DateTime.makeUnsafe(1) },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        }),
      )

      const state = [{ content: "directory todo", status: "pending", priority: "high" }]
      yield* todos.update({ sessionID: fileSessionID, todos: state })
      expect(yield* Effect.promise(() => readSessionTodoProjection(directory, fileSessionID))).toEqual({
        hasState: true,
        todos: state,
      })
      expect(
        yield* db.select().from(TodoTable).where(eq(TodoTable.session_id, fileSessionID)).all().pipe(Effect.orDie),
      ).toEqual([])

      yield* db.delete(TodoTable).where(eq(TodoTable.session_id, fileSessionID)).run().pipe(Effect.orDie)
      yield* Effect.promise(() =>
        rm(path.join(directory, ".agents", "atree", "sessions", fileSessionID, "todo.json"), { force: true }),
      )
      expect(yield* Effect.promise(() => readSessionTodoProjection(directory, fileSessionID))).toEqual({
        hasState: true,
        todos: state,
      })
      expect(yield* todos.get(fileSessionID)).toEqual(state)
    }),
  )

  it.effect("does not revive stale database todos when a file-backed session has no todo state", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "atree-core-todo-missing-state-"))),
        (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      const { db } = yield* Database.Service
      const todos = yield* SessionTodo.Service
      const fileSessionID = SessionV2.ID.make("ses_core_file_todo_missing_state")
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make(directory), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: fileSessionID,
          project_id: Project.ID.global,
          slug: "file-todo-missing-state",
          directory,
          title: "file todo missing state",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(TodoTable)
        .values({
          session_id: fileSessionID,
          content: "stale core database todo",
          status: "pending",
          priority: "low",
          position: 0,
        })
        .run()
        .pipe(Effect.orDie)
      yield* Effect.promise(() =>
        writeSessionStore({
          id: fileSessionID,
          projectID: Project.ID.global,
          title: "file todo missing state",
          location: { directory: AbsolutePath.make(directory) },
          time: { created: DateTime.makeUnsafe(1), updated: DateTime.makeUnsafe(1) },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        }),
      )

      expect(yield* todos.get(fileSessionID)).toEqual([])
    }),
  )

  it.effect("updates a file-backed todo list without a SQLite session row", () =>
    Effect.gen(function* () {
      const data = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "atree-core-todo-no-row-data-"))),
        (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "atree-core-todo-no-row-root-"))),
        (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      const directory = path.join(root, "node")
      const previousData = Global.Path.data
      ;(Global.Path as { data: string }).data = data
      yield* Effect.addFinalizer(() => Effect.sync(() => ((Global.Path as { data: string }).data = previousData)))
      yield* Effect.promise(() => mkdir(path.join(data, "atree"), { recursive: true }))
      yield* Effect.promise(() =>
        writeFile(path.join(data, "atree", "state.json"), JSON.stringify({ version: 1, rootDirectory: root })),
      )
      yield* Effect.promise(() => mkdir(directory, { recursive: true }))

      const { db } = yield* Database.Service
      const todos = yield* SessionTodo.Service
      const fileSessionID = SessionV2.ID.make("ses_core_file_todo_no_row")
      yield* Effect.promise(() =>
        writeSessionStore({
          id: fileSessionID,
          projectID: Project.ID.global,
          title: "file todo no row",
          location: { directory: AbsolutePath.make(directory) },
          time: { created: DateTime.makeUnsafe(1), updated: DateTime.makeUnsafe(1) },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        }),
      )

      const state = [{ content: "directory-only todo", status: "pending", priority: "high" }]
      yield* todos.update({ sessionID: fileSessionID, todos: state })

      expect(yield* todos.get(fileSessionID)).toEqual(state)
      expect(yield* Effect.promise(() => readSessionTodoProjection(directory, fileSessionID))).toEqual({
        hasState: true,
        todos: state,
      })
      expect(
        yield* db.select().from(SessionTable).where(eq(SessionTable.id, fileSessionID)).get().pipe(Effect.orDie),
      ).toBeUndefined()
      expect(
        yield* db.select().from(TodoTable).where(eq(TodoTable.session_id, fileSessionID)).all().pipe(Effect.orDie),
      ).toEqual([])
    }),
  )

  it.effect("prefers todo state from the persisted root copy over a still-valid SQLite directory row", () =>
    Effect.gen(function* () {
      const data = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "atree-core-todo-data-"))),
        (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "atree-core-todo-root-"))),
        (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      const source = path.join(root, "source")
      const target = path.join(root, "target")
      const previousData = Global.Path.data
      ;(Global.Path as { data: string }).data = data
      yield* Effect.addFinalizer(() => Effect.sync(() => ((Global.Path as { data: string }).data = previousData)))
      yield* Effect.promise(() => mkdir(path.join(data, "atree"), { recursive: true }))
      yield* Effect.promise(() =>
        writeFile(path.join(data, "atree", "state.json"), JSON.stringify({ version: 1, rootDirectory: root })),
      )
      yield* Effect.promise(() => mkdir(source, { recursive: true }))
      yield* Effect.promise(() => mkdir(target, { recursive: true }))

      const { db } = yield* Database.Service
      const todos = yield* SessionTodo.Service
      const fileSessionID = SessionV2.ID.make("ses_core_file_todo_root_copy")
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make(source), sandboxes: [] })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: fileSessionID,
          project_id: Project.ID.global,
          slug: "file-todo-root-copy",
          directory: source,
          title: "source todo",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)

      const sourceSession = {
        id: fileSessionID,
        projectID: Project.ID.global,
        title: "source todo",
        location: { directory: AbsolutePath.make(source) },
        time: { created: DateTime.makeUnsafe(1), updated: DateTime.makeUnsafe(1) },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      }
      const targetSession = {
        ...sourceSession,
        title: "target todo",
        location: { directory: AbsolutePath.make(target) },
        time: { created: DateTime.makeUnsafe(1), updated: DateTime.makeUnsafe(2) },
      }
      yield* Effect.promise(() => writeSessionStore(sourceSession))
      yield* Effect.promise(() => writeSessionStore(targetSession))
      yield* Effect.promise(() =>
        appendSessionJsonl(sourceSession, {
          type: "todo.updated",
          sessionID: fileSessionID,
          todos: [{ content: "source todo", status: "pending", priority: "low" }],
        }),
      )
      const targetTodos = [{ content: "target todo", status: "in_progress", priority: "high" }]
      yield* Effect.promise(() =>
        appendSessionJsonl(targetSession, {
          type: "todo.updated",
          sessionID: fileSessionID,
          todos: targetTodos,
        }),
      )

      expect(yield* todos.get(fileSessionID)).toEqual(targetTodos)
    }),
  )

  it.effect("uses the explicit directory when reading and updating overlapping file-backed todos", () =>
    Effect.gen(function* () {
      const data = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "atree-core-todo-overlap-data-"))),
        (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "atree-core-todo-overlap-root-"))),
        (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      const source = path.join(root, "source")
      const target = path.join(root, "target")
      const previousData = Global.Path.data
      ;(Global.Path as { data: string }).data = data
      yield* Effect.addFinalizer(() => Effect.sync(() => ((Global.Path as { data: string }).data = previousData)))
      yield* Effect.promise(() => mkdir(path.join(data, "atree"), { recursive: true }))
      yield* Effect.promise(() =>
        writeFile(path.join(data, "atree", "state.json"), JSON.stringify({ version: 1, rootDirectory: root })),
      )
      yield* Effect.promise(() => mkdir(source, { recursive: true }))
      yield* Effect.promise(() => mkdir(target, { recursive: true }))

      const todos = yield* SessionTodo.Service
      const fileSessionID = SessionV2.ID.make("ses_core_file_todo_overlap")
      const sourceSession = {
        id: fileSessionID,
        projectID: Project.ID.global,
        title: "source todo",
        location: { directory: AbsolutePath.make(source) },
        time: { created: DateTime.makeUnsafe(1), updated: DateTime.makeUnsafe(200) },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      }
      const targetSession = {
        ...sourceSession,
        title: "target todo",
        location: { directory: AbsolutePath.make(target) },
        time: { created: DateTime.makeUnsafe(1), updated: DateTime.makeUnsafe(100) },
      }
      yield* Effect.promise(() => writeSessionStore(sourceSession))
      yield* Effect.promise(() => writeSessionStore(targetSession))
      yield* Effect.promise(() =>
        appendSessionJsonl(sourceSession, {
          type: "todo.updated",
          sessionID: fileSessionID,
          todos: [{ content: "source todo", status: "pending", priority: "low" }],
        }),
      )
      yield* Effect.promise(() =>
        appendSessionJsonl(targetSession, {
          type: "todo.updated",
          sessionID: fileSessionID,
          todos: [{ content: "target todo", status: "pending", priority: "medium" }],
        }),
      )

      expect(yield* todos.get(fileSessionID, { directory: target })).toEqual([
        { content: "target todo", status: "pending", priority: "medium" },
      ])

      const replacement = [{ content: "target replacement", status: "in_progress", priority: "high" }]
      yield* todos.update({ sessionID: fileSessionID, directory: target, todos: replacement })

      expect(yield* Effect.promise(() => readSessionTodoProjection(target, fileSessionID))).toEqual({
        hasState: true,
        todos: replacement,
      })
      expect(yield* Effect.promise(() => readSessionTodoProjection(source, fileSessionID))).toEqual({
        hasState: true,
        todos: [{ content: "source todo", status: "pending", priority: "low" }],
      })
    }),
  )

  it.effect("does not revive persisted-root todos when the session store was removed", () =>
    Effect.gen(function* () {
      const data = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "atree-core-todo-stale-data-"))),
        (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "atree-core-todo-stale-root-"))),
        (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      const node = path.join(root, "node")
      const previousData = Global.Path.data
      ;(Global.Path as { data: string }).data = data
      yield* Effect.addFinalizer(() => Effect.sync(() => ((Global.Path as { data: string }).data = previousData)))
      yield* Effect.promise(() => mkdir(path.join(data, "atree"), { recursive: true }))
      yield* Effect.promise(() =>
        writeFile(path.join(data, "atree", "state.json"), JSON.stringify({ version: 1, rootDirectory: root })),
      )
      yield* Effect.promise(() => mkdir(node, { recursive: true }))

      const { db } = yield* Database.Service
      const todos = yield* SessionTodo.Service
      const fileSessionID = SessionV2.ID.make("ses_core_file_todo_stale_only")
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make(node), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: fileSessionID,
          project_id: Project.ID.global,
          slug: "file-todo-stale-only",
          directory: node,
          title: "file todo stale only",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(TodoTable)
        .values({
          session_id: fileSessionID,
          content: "stale root database todo",
          status: "pending",
          priority: "low",
          position: 0,
        })
        .run()
        .pipe(Effect.orDie)
      yield* Effect.promise(() =>
        writeSessionStore({
          id: fileSessionID,
          projectID: Project.ID.global,
          title: "file todo stale only",
          location: { directory: AbsolutePath.make(node) },
          time: { created: DateTime.makeUnsafe(1), updated: DateTime.makeUnsafe(1) },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        }),
      )
      yield* Effect.promise(() =>
        rm(path.join(node, ".agents", "atree", "sessions", fileSessionID), { recursive: true, force: true }),
      )

      expect(yield* todos.get(fileSessionID)).toEqual([])
    }),
  )

  it.effect("does not revive persisted-root todos through a symlinked cached directory", () =>
    Effect.gen(function* () {
      const data = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "atree-core-todo-realpath-data-"))),
        (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "atree-core-todo-realpath-root-"))),
        (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      const alias = `${root}-alias`
      const node = path.join(alias, "node")
      const previousData = Global.Path.data
      ;(Global.Path as { data: string }).data = data
      yield* Effect.addFinalizer(() => Effect.sync(() => ((Global.Path as { data: string }).data = previousData)))
      yield* Effect.addFinalizer(() => Effect.promise(() => rm(alias, { force: true })).pipe(Effect.ignore))
      yield* Effect.promise(() => rm(alias, { force: true }))
      yield* Effect.promise(() => symlink(root, alias, "dir"))
      yield* Effect.promise(() => mkdir(path.join(root, "node"), { recursive: true }))
      yield* Effect.promise(() => mkdir(path.join(data, "atree"), { recursive: true }))
      yield* Effect.promise(() =>
        writeFile(path.join(data, "atree", "state.json"), JSON.stringify({ version: 1, rootDirectory: root })),
      )

      const { db } = yield* Database.Service
      const todos = yield* SessionTodo.Service
      const fileSessionID = SessionV2.ID.make("ses_core_file_todo_symlink_stale")
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make(node), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: fileSessionID,
          project_id: Project.ID.global,
          slug: "file-todo-symlink-stale",
          directory: node,
          title: "file todo symlink stale",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(TodoTable)
        .values({
          session_id: fileSessionID,
          content: "stale symlink root database todo",
          status: "pending",
          priority: "low",
          position: 0,
        })
        .run()
        .pipe(Effect.orDie)

      expect(yield* todos.get(fileSessionID)).toEqual([])
    }),
  )

  it.effect("records file-backed todo events before refreshing the directory projection", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "atree-core-todo-event-first-"))),
        (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      const { db } = yield* Database.Service
      const todos = yield* SessionTodo.Service
      const fileSessionID = SessionV2.ID.make("ses_core_file_todo_event_first")
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make(directory), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: fileSessionID,
          project_id: Project.ID.global,
          slug: "file-todo-event-first",
          directory,
          title: "file todo event first",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      yield* Effect.promise(() =>
        writeSessionStore({
          id: fileSessionID,
          projectID: Project.ID.global,
          title: "file todo event first",
          location: { directory: AbsolutePath.make(directory) },
          time: { created: DateTime.makeUnsafe(1), updated: DateTime.makeUnsafe(1) },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        }),
      )

      const state = [{ content: "core event before projection", status: "pending", priority: "medium" }]
      yield* todos.update({ sessionID: fileSessionID, todos: state })

      const raw = yield* Effect.promise(() =>
        readFile(path.join(directory, ".agents", "atree", "sessions", fileSessionID, "session.jsonl"), "utf8"),
      )
      const todoEvent = raw
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .find((entry) => entry.type === "todo.updated")
      const touched = yield* Effect.promise(() => readSessionStore(directory, fileSessionID))

      expect(todoEvent).toMatchObject({ type: "todo.updated", sessionID: fileSessionID, todos: state })
      expect(typeof todoEvent?.at).toBe("number")
      expect(touched ? DateTime.toEpochMillis(touched.time.updated) : 0).toBeGreaterThanOrEqual(todoEvent?.at as number)
    }),
  )

  it.effect("does not read legacy directory todo state as session state", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "atree-core-todo-legacy-"))),
        (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      const { db } = yield* Database.Service
      const todos = yield* SessionTodo.Service
      const fileSessionID = SessionV2.ID.make("ses_core_file_todo_legacy")
      const state = [{ content: "legacy directory todo", status: "pending", priority: "medium" }]

      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make(directory), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: fileSessionID,
          project_id: Project.ID.global,
          slug: "file-todo-legacy",
          directory,
          title: "file todo legacy",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      yield* Effect.promise(() =>
        writeSessionStore({
          id: fileSessionID,
          projectID: Project.ID.global,
          title: "file todo legacy",
          location: { directory: AbsolutePath.make(directory) },
          time: { created: DateTime.makeUnsafe(1), updated: DateTime.makeUnsafe(20) },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        }),
      )
      yield* Effect.promise(() => mkdir(path.join(directory, ".agents", "atree", "extensions", "todo"), { recursive: true }))
      yield* Effect.promise(() =>
        Bun.write(
          path.join(directory, ".agents", "atree", "extensions", "todo", "state.json"),
          JSON.stringify({ version: 1, updatedAt: 1, sessions: { [fileSessionID]: state } }),
        ),
      )

      expect(yield* todos.get(fileSessionID)).toEqual([])

      yield* todos.update({ sessionID: fileSessionID, todos: [] })
      expect(yield* Effect.promise(() => readSessionTodoProjection(directory, fileSessionID))).toEqual({
        hasState: true,
        todos: [],
      })
      const touched = yield* Effect.promise(() => readSessionStore(directory, fileSessionID))
      expect(touched ? DateTime.toEpochMillis(touched.time.updated) : 0).toBeGreaterThan(20)
    }),
  )

  it.effect("restores todo state from versioned session jsonl events", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "atree-core-todo-versioned-"))),
        (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      const fileSessionID = SessionV2.ID.make("ses_core_file_todo_versioned")
      const session = {
        id: fileSessionID,
        projectID: Project.ID.global,
        title: "file todo versioned",
        location: { directory: AbsolutePath.make(directory) },
        time: { created: DateTime.makeUnsafe(1), updated: DateTime.makeUnsafe(1) },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      }
      yield* Effect.promise(() => writeSessionStore(session))
      yield* Effect.promise(() =>
        appendSessionJsonl(session, {
          type: "todo.updated.1",
          sessionID: fileSessionID,
          todos: [{ content: "versioned core todo", status: "pending", priority: "medium" }],
        }),
      )

      expect(yield* Effect.promise(() => readSessionTodoProjection(directory, fileSessionID))).toEqual({
        hasState: true,
        todos: [{ content: "versioned core todo", status: "pending", priority: "medium" }],
      })
    }),
  )

  it.effect("restores todo state from nested session jsonl event data", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "atree-core-todo-nested-"))),
        (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      const fileSessionID = SessionV2.ID.make("ses_core_file_todo_nested")
      const session = {
        id: fileSessionID,
        projectID: Project.ID.global,
        title: "file todo nested",
        location: { directory: AbsolutePath.make(directory) },
        time: { created: DateTime.makeUnsafe(1), updated: DateTime.makeUnsafe(1) },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      }
      yield* Effect.promise(() => writeSessionStore(session))
      yield* Effect.promise(() =>
        appendSessionJsonl(session, {
          type: "todo.updated",
          at: 10,
          data: {
            sessionID: fileSessionID,
            todos: [{ content: "nested core todo", status: "pending", priority: "medium" }],
          },
        }),
      )

      expect(yield* Effect.promise(() => readSessionTodoProjection(directory, fileSessionID))).toEqual({
        hasState: true,
        todos: [{ content: "nested core todo", status: "pending", priority: "medium" }],
      })
    }),
  )

  it.effect("prefers newer todo jsonl events over a stale todo projection", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "atree-core-todo-jsonl-newer-"))),
        (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      const fileSessionID = SessionV2.ID.make("ses_core_file_todo_jsonl_newer")
      const session = {
        id: fileSessionID,
        projectID: Project.ID.global,
        title: "file todo jsonl newer",
        location: { directory: AbsolutePath.make(directory) },
        time: { created: DateTime.makeUnsafe(1), updated: DateTime.makeUnsafe(1) },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      }
      const stale = [{ content: "stale projection", status: "pending", priority: "low" }]
      const current = [{ content: "current jsonl", status: "completed", priority: "high" }]
      yield* Effect.promise(() => writeSessionStore(session))
      yield* Effect.promise(() =>
        Bun.write(
          path.join(directory, ".agents", "atree", "sessions", fileSessionID, "todo.json"),
          JSON.stringify({ version: 1, updatedAt: 10, todos: stale }),
        ),
      )
      yield* Effect.promise(() =>
        appendSessionJsonl(session, {
          type: "todo.updated",
          sessionID: fileSessionID,
          todos: current,
        }),
      )

      expect(yield* Effect.promise(() => readSessionTodoProjection(directory, fileSessionID))).toEqual({
        hasState: true,
        todos: current,
      })
    }),
  )

  it.effect("prefers todo jsonl events over a newer projection file", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "atree-core-todo-jsonl-authoritative-"))),
        (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      const fileSessionID = SessionV2.ID.make("ses_core_file_todo_jsonl_authoritative")
      const session = {
        id: fileSessionID,
        projectID: Project.ID.global,
        title: "file todo jsonl authoritative",
        location: { directory: AbsolutePath.make(directory) },
        time: { created: DateTime.makeUnsafe(1), updated: DateTime.makeUnsafe(1) },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      }
      const projected = [{ content: "newer projection", status: "pending", priority: "low" }]
      const jsonl = [{ content: "authoritative jsonl", status: "completed", priority: "high" }]
      yield* Effect.promise(() => writeSessionStore(session))
      yield* Effect.promise(() =>
        Bun.write(
          path.join(directory, ".agents", "atree", "sessions", fileSessionID, "todo.json"),
          JSON.stringify({ version: 1, updatedAt: 9999, todos: projected }),
        ),
      )
      yield* Effect.promise(() =>
        appendSessionJsonl(session, {
          type: "todo.updated",
          at: 1,
          sessionID: fileSessionID,
          todos: jsonl,
        }),
      )

      expect(yield* Effect.promise(() => readSessionTodoProjection(directory, fileSessionID))).toEqual({
        hasState: true,
        todos: jsonl,
      })
    }),
  )
})
