import { describe, expect } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Database } from "@opencode-ai/core/database/database"
import { TodoTable } from "@opencode-ai/core/session/sql"
import { eq } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { readSessionTodoState, writeSessionTodoState } from "../../src/atree/todo-store"
import { writeSessionStore } from "../../src/atree/session-store"
import { Session } from "../../src/session/session"
import { type SessionID } from "../../src/session/schema"
import { Todo } from "../../src/session/todo"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(Todo.defaultLayer, Session.defaultLayer, Database.defaultLayer))

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
})
