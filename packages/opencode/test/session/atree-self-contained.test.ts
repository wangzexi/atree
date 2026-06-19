import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Database } from "@opencode-ai/core/database/database"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { MessageTable, PartTable, SessionTable, TodoTable } from "@opencode-ai/core/session/sql"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { and, eq } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { readSessionScheduleState } from "@/atree/schedule-store"
import { readSessionStore } from "@/atree/session-store"
import { readSessionTodoState } from "@/atree/todo-store"
import { BackgroundJob } from "@/background/job"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { EventV2Bridge } from "@/event-v2-bridge"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Schedule } from "@/session/schedule"
import { ScheduleRunTable, ScheduleTable } from "@/session/schedule.sql"
import { MessageID, PartID } from "@/session/schema"
import { Session } from "@/session/session"
import { Todo } from "@/session/todo"
import { Storage } from "@/storage/storage"
import { TestInstance, testInstanceStoreLayer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  Layer.mergeAll(
    Database.defaultLayer,
    Session.layer.pipe(
      Layer.provide(Storage.defaultLayer),
      Layer.provide(Database.defaultLayer),
      Layer.provideMerge(EventV2Bridge.defaultLayer),
      Layer.provide(SessionProjector.defaultLayer),
      Layer.provide(RuntimeFlags.layer({ experimentalWorkspaces: false })),
      Layer.provide(BackgroundJob.defaultLayer),
    ),
    Schedule.defaultLayer,
    Todo.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    testInstanceStoreLayer,
  ),
)

describe("atree directory self-contained state", () => {
  it.instance("recovers session state, messages, schedules, and todos after SQLite projections are removed", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const schedules = yield* Schedule.Service
      const todo = yield* Todo.Service
      const instance = yield* TestInstance
      const { db } = yield* Database.Service

      const active = yield* sessions.create({ title: "directory-backed active", metadata: { icon: "🧭" } })
      const archived = yield* sessions.create({ title: "directory-backed archived", metadata: { icon: "🦊" } })
      yield* sessions.setArchived({ sessionID: archived.id, time: 1234 })

      const messageID = MessageID.ascending()
      const partID = PartID.ascending()
      const filePartID = PartID.ascending()
      yield* sessions.updateMessage({
        id: messageID,
        sessionID: active.id,
        role: "user",
        time: { created: Date.now() },
        agent: "user",
        model: { providerID: "test", modelID: "test" },
        tools: {},
        mode: "",
      } as unknown as SessionV1.Info)
      yield* sessions.updatePart({
        id: partID,
        messageID,
        sessionID: active.id,
        type: "text",
        text: "message restored from session.jsonl",
      })
      yield* sessions.updatePart({
        id: filePartID,
        messageID,
        sessionID: active.id,
        type: "file",
        mime: "image/png",
        filename: "self-contained.png",
        url: "data:image/png;base64,c2VsZi1jb250YWluZWQ=",
      })

      const schedule = yield* schedules.create({
        sessionID: active.id,
        kind: "once",
        runAt: Date.now() + 120_000,
        message: "schedule restored from the session directory",
      })
      yield* todo.update({
        sessionID: active.id,
        todos: [{ content: "todo restored from the session directory", status: "pending", priority: "high" }],
      })

      const activeRoot = path.join(instance.directory, ".agents", "atree", "sessions", active.id)
      expect((yield* Effect.promise(() => fs.stat(path.join(activeRoot, "meta.yaml")))).isFile()).toBe(true)
      expect((yield* Effect.promise(() => fs.stat(path.join(activeRoot, "session.jsonl")))).isFile()).toBe(true)
      expect((yield* Effect.promise(() => fs.stat(path.join(activeRoot, "schedule.json")))).isFile()).toBe(true)
      expect((yield* Effect.promise(() => fs.stat(path.join(activeRoot, "todo.json")))).isFile()).toBe(true)
      expect(yield* Effect.promise(() => fs.readdir(path.join(activeRoot, "assets")))).toHaveLength(1)
      expect(yield* Effect.promise(() => fs.readFile(path.join(activeRoot, "session.jsonl"), "utf8"))).not.toContain(
        "data:image/png;base64",
      )
      expect(yield* Effect.promise(() => readSessionScheduleState(instance.directory, active.id))).toHaveLength(1)
      expect(yield* Effect.promise(() => readSessionTodoState(instance.directory, active.id))).toHaveLength(1)

      yield* db.delete(ScheduleRunTable).where(eq(ScheduleRunTable.schedule_id, schedule.id)).run().pipe(Effect.orDie)
      yield* db.delete(ScheduleTable).where(eq(ScheduleTable.session_id, active.id)).run().pipe(Effect.orDie)
      yield* db.delete(TodoTable).where(eq(TodoTable.session_id, active.id)).run().pipe(Effect.orDie)
      yield* db.delete(PartTable).where(eq(PartTable.session_id, active.id)).run().pipe(Effect.orDie)
      yield* db.delete(MessageTable).where(eq(MessageTable.session_id, active.id)).run().pipe(Effect.orDie)
      yield* db
        .delete(SessionTable)
        .where(and(eq(SessionTable.id, active.id), eq(SessionTable.directory, instance.directory)))
        .run()
        .pipe(Effect.orDie)
      yield* db
        .delete(SessionTable)
        .where(and(eq(SessionTable.id, archived.id), eq(SessionTable.directory, instance.directory)))
        .run()
        .pipe(Effect.orDie)

      const restoredActive = yield* sessions.get(active.id)
      const restoredArchived = yield* sessions.get(archived.id)
      expect(restoredActive.title).toBe("directory-backed active")
      expect(restoredActive.metadata).toEqual({ icon: "🧭" })
      expect(restoredArchived.time.archived).toBe(1234)
      expect((yield* Effect.promise(() => readSessionStore(instance.directory, archived.id)))?.time.archived).toBe(1234)

      const activeSessions = yield* sessions.list({ directory: instance.directory })
      expect(activeSessions.map((session) => session.id)).toContain(active.id)
      expect(activeSessions.map((session) => session.id)).not.toContain(archived.id)
      const allSessions = yield* sessions.list({ directory: instance.directory, archived: true })
      expect(allSessions.map((session) => session.id)).toEqual(expect.arrayContaining([active.id, archived.id]))

      const messages = yield* sessions.messages({ sessionID: active.id })
      expect(messages).toHaveLength(1)
      expect(messages[0]?.parts[0]).toMatchObject({ id: partID, text: "message restored from session.jsonl" })
      expect(messages[0]?.parts[1]).toMatchObject({
        id: filePartID,
        type: "file",
        url: "data:image/png;base64,c2VsZi1jb250YWluZWQ=",
      })

      const restoredSchedules = yield* schedules.list(active.id)
      expect(restoredSchedules).toHaveLength(1)
      expect(restoredSchedules[0]).toMatchObject({
        id: schedule.id,
        message: "schedule restored from the session directory",
      })
      expect(yield* todo.get(active.id)).toEqual([
        { content: "todo restored from the session directory", status: "pending", priority: "high" },
      ])
    }),
  )

  it.instance("removing a scheduled session clears its directory store and schedule runtime cache", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const schedules = yield* Schedule.Service
      const instance = yield* TestInstance
      const { db } = yield* Database.Service

      const session = yield* sessions.create({ title: "scheduled delete" })
      const schedule = yield* schedules.create({
        sessionID: session.id,
        kind: "once",
        runAt: Date.now() + 120_000,
        message: "should be deleted with the session",
      })
      expect(yield* schedules.list(session.id)).toHaveLength(1)

      yield* sessions.remove(session.id)

      expect(yield* schedules.list(session.id)).toEqual([])
      expect(yield* Effect.promise(() => readSessionScheduleState(instance.directory, session.id))).toEqual([])
      expect(yield* Effect.promise(() => readSessionStore(instance.directory, session.id))).toBeUndefined()
      const row = yield* db
        .select({ id: ScheduleTable.id })
        .from(ScheduleTable)
        .where(eq(ScheduleTable.id, schedule.id))
        .get()
        .pipe(Effect.orDie)
      expect(row).toBeUndefined()
    }),
  )
})
