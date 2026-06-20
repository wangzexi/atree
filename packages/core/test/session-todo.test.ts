import { describe, expect } from "bun:test"
import { asc, eq } from "drizzle-orm"
import { DateTime, Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { readSessionStore, writeSessionStore } from "@opencode-ai/core/atree/session-store"
import { readSessionTodoProjection } from "@opencode-ai/core/atree/todo-store"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionTable, TodoTable } from "@opencode-ai/core/session/sql"
import { SessionTodo } from "@opencode-ai/core/session/todo"
import { testEffect } from "./lib/effect"
import { mkdir, mkdtemp, rm } from "fs/promises"
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
  it.effect("replaces persisted todos in order and publishes updates", () =>
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
      expect(yield* todos.get(sessionID)).toEqual([
        { content: "second", status: "pending", priority: "low" },
        { content: "first", status: "in_progress", priority: "high" },
      ])
      expect(
        (yield* db.select().from(TodoTable).orderBy(asc(TodoTable.position)).all().pipe(Effect.orDie)).map((row) => ({
          content: row.content,
          position: row.position,
        })),
      ).toEqual([
        { content: "second", position: 0 },
        { content: "first", position: 1 },
      ])

      yield* todos.update({ sessionID, todos: [{ content: "replacement", status: "completed", priority: "medium" }] })
      expect(yield* todos.get(sessionID)).toEqual([{ content: "replacement", status: "completed", priority: "medium" }])

      yield* todos.update({ sessionID, todos: [] })
      expect(yield* todos.get(sessionID)).toEqual([])
      expect(published.map((event) => event.data)).toEqual([
        {
          sessionID,
          todos: [
            { content: "second", status: "pending", priority: "low" },
            { content: "first", status: "in_progress", priority: "high" },
          ],
        },
        { sessionID, todos: [{ content: "replacement", status: "completed", priority: "medium" }] },
        { sessionID, todos: [] },
      ])
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

      yield* db.delete(TodoTable).where(eq(TodoTable.session_id, fileSessionID)).run().pipe(Effect.orDie)
      expect(yield* todos.get(fileSessionID)).toEqual(state)
    }),
  )

  it.effect("reads legacy directory todo state until the session is rewritten", () =>
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

      expect(yield* todos.get(fileSessionID)).toEqual(state)

      yield* todos.update({ sessionID: fileSessionID, todos: [] })
      expect(yield* Effect.promise(() => readSessionTodoProjection(directory, fileSessionID))).toEqual({
        hasState: true,
        todos: [],
      })
      const legacyRaw = yield* Effect.promise(() =>
        Bun.file(path.join(directory, ".agents", "atree", "extensions", "todo", "state.json")).json(),
      )
      expect(legacyRaw.sessions[fileSessionID]).toBeUndefined()
      const touched = yield* Effect.promise(() => readSessionStore(directory, fileSessionID))
      expect(touched ? DateTime.toEpochMillis(touched.time.updated) : 0).toBeGreaterThan(20)
    }),
  )
})
