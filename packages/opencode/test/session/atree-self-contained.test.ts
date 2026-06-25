import { describe, expect } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Database } from "@opencode-ai/core/database/database"
import { Global } from "@opencode-ai/core/global"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { MessageTable, PartTable, SessionTable, TodoTable } from "@opencode-ai/core/session/sql"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { and, eq } from "drizzle-orm"
import { Effect, Fiber, Layer } from "effect"
import { readSessionScheduleState, writeSessionScheduleState } from "@/atree/schedule-store"
import { appendSessionJsonl, readSessionStore, writeSessionStore } from "@/atree/session-store"
import { writeWorkspaceRoot } from "@/atree/state"
import { readSessionTodoState } from "@/atree/todo-store"
import { BackgroundJob } from "@/background/job"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Permission } from "@/permission"
import { Question } from "@/question"
import { QuestionID } from "@/question/schema"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Schedule } from "@/session/schedule"
import { ScheduleRunTable, ScheduleTable } from "@/session/schedule.sql"
import { MessageID, PartID, SessionID } from "@/session/schema"
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
    Question.layer.pipe(Layer.provideMerge(EventV2Bridge.defaultLayer)),
    Permission.layer.pipe(Layer.provideMerge(EventV2Bridge.defaultLayer)),
    CrossSpawnSpawner.defaultLayer,
    testInstanceStoreLayer,
  ),
)

const waitFor = <T>(load: Effect.Effect<T | undefined>) =>
  Effect.gen(function* () {
    for (let i = 0; i < 20; i++) {
      const value = yield* load
      if (value !== undefined) return value
      yield* Effect.sleep("10 millis")
    }
    throw new Error("timed out waiting for pending request")
  })

describe("atree directory self-contained state", () => {
  it.instance("restores pending question and permission lists from session.jsonl", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const questions = yield* Question.Service
      const permissions = yield* Permission.Service

      const session = yield* sessions.create({ title: "restored interactions" })
      const pendingQuestionID = QuestionID.ascending("que_atree_restore_pending")
      const answeredQuestionID = QuestionID.ascending("que_atree_restore_answered")
      const pendingPermissionID = PermissionV1.ID.ascending("per_atree_restore_pending")
      const answeredPermissionID = PermissionV1.ID.ascending("per_atree_restore_answered")

      yield* Effect.promise(() =>
        appendSessionJsonl(session, {
          type: "question.asked",
          question: {
            id: pendingQuestionID,
            sessionID: session.id,
            questions: [
              {
                question: "Restore this question?",
                header: "Restore",
                options: [{ label: "Yes", description: "Keep it pending" }],
              },
            ],
          },
        }),
      )
      yield* Effect.promise(() =>
        appendSessionJsonl(session, {
          type: "question.asked",
          question: {
            id: answeredQuestionID,
            sessionID: session.id,
            questions: [
              {
                question: "Already answered?",
                header: "Done",
                options: [{ label: "Yes", description: "Do not restore" }],
              },
            ],
          },
        }),
      )
      yield* Effect.promise(() =>
        appendSessionJsonl(session, {
          type: "question.replied",
          sessionID: session.id,
          requestID: answeredQuestionID,
          answers: [["Yes"]],
        }),
      )
      yield* Effect.promise(() =>
        appendSessionJsonl(session, {
          type: "permission.asked",
          permission: {
            id: pendingPermissionID,
            sessionID: session.id,
            permission: "bash",
            patterns: ["echo pending"],
            metadata: {},
            always: [],
          },
        }),
      )
      yield* Effect.promise(() =>
        appendSessionJsonl(session, {
          type: "permission.asked",
          permission: {
            id: answeredPermissionID,
            sessionID: session.id,
            permission: "bash",
            patterns: ["echo answered"],
            metadata: {},
            always: [],
          },
        }),
      )
      yield* Effect.promise(() =>
        appendSessionJsonl(session, {
          type: "permission.replied",
          sessionID: session.id,
          requestID: answeredPermissionID,
          reply: "once",
        }),
      )

      const restoredQuestions = yield* questions.list()
      const restoredPermissions = yield* permissions.list()

      expect(restoredQuestions.map((item) => item.id)).toEqual([pendingQuestionID])
      expect(restoredQuestions[0]?.sessionID).toBe(session.id)
      expect(restoredPermissions.map((item) => item.id)).toEqual([pendingPermissionID])
      expect(restoredPermissions[0]?.sessionID).toBe(session.id)
    }),
  )

  it.instance("does not restore pending question and permission lists from archived sessions", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const questions = yield* Question.Service
      const permissions = yield* Permission.Service

      const session = yield* sessions.create({ title: "archived interactions" })
      const pendingQuestionID = QuestionID.ascending("que_atree_archived_pending")
      const pendingPermissionID = PermissionV1.ID.ascending("per_atree_archived_pending")

      yield* Effect.promise(() =>
        appendSessionJsonl(session, {
          type: "question.asked",
          question: {
            id: pendingQuestionID,
            sessionID: session.id,
            questions: [
              {
                question: "Restore from archived?",
                header: "Archived",
                options: [{ label: "No", description: "Archived sessions are inactive" }],
              },
            ],
          },
        }),
      )
      yield* Effect.promise(() =>
        appendSessionJsonl(session, {
          type: "permission.asked",
          permission: {
            id: pendingPermissionID,
            sessionID: session.id,
            permission: "bash",
            patterns: ["echo archived"],
            metadata: {},
            always: [],
          },
        }),
      )
      yield* sessions.setArchived({ sessionID: session.id, time: 1234 })

      expect(yield* questions.list()).toEqual([])
      expect(yield* permissions.list()).toEqual([])
    }),
  )

  it.instance("replies to restored pending question and permission from session.jsonl", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const questions = yield* Question.Service
      const permissions = yield* Permission.Service
      const instance = yield* TestInstance

      const session = yield* sessions.create({ title: "restored interaction replies" })
      const pendingQuestionID = QuestionID.ascending("que_atree_restore_reply")
      const pendingPermissionID = PermissionV1.ID.ascending("per_atree_restore_reply")

      yield* Effect.promise(() =>
        appendSessionJsonl(session, {
          type: "question.asked",
          question: {
            id: pendingQuestionID,
            sessionID: session.id,
            questions: [
              {
                question: "Reply to restored question?",
                header: "Restore",
                options: [{ label: "Yes", description: "Append the reply" }],
              },
            ],
          },
        }),
      )
      yield* Effect.promise(() =>
        appendSessionJsonl(session, {
          type: "permission.asked",
          permission: {
            id: pendingPermissionID,
            sessionID: session.id,
            permission: "bash",
            patterns: ["echo restored"],
            metadata: {},
            always: [],
          },
        }),
      )

      expect((yield* questions.list()).map((item) => item.id)).toEqual([pendingQuestionID])
      expect((yield* permissions.list()).map((item) => item.id)).toEqual([pendingPermissionID])

      yield* questions.reply({ requestID: pendingQuestionID, answers: [["Yes"]] })
      yield* permissions.reply({ requestID: pendingPermissionID, reply: "once" })

      expect(yield* questions.list()).toEqual([])
      expect(yield* permissions.list()).toEqual([])

      const raw = yield* Effect.promise(() =>
        fs.readFile(path.join(instance.directory, ".agents", "atree", "sessions", session.id, "session.jsonl"), "utf8"),
      )
      const entries = raw
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, any>)

      expect(entries).toContainEqual(
        expect.objectContaining({
          type: "question.replied",
          sessionID: session.id,
          requestID: pendingQuestionID,
          answers: [["Yes"]],
        }),
      )
      expect(entries).toContainEqual(
        expect.objectContaining({
          type: "permission.replied",
          sessionID: session.id,
          requestID: pendingPermissionID,
          reply: "once",
        }),
      )
    }),
  )

  it.instance("restores copied pending question and permission entries without collapsing duplicate ids", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const source = path.join(instance.directory, "source")
      const target = path.join(instance.directory, "target")
      const sessionID = "ses_copied_pending_runtime" as SessionID
      const questionID = QuestionID.ascending("que_copied_runtime")
      const permissionID = PermissionV1.ID.ascending("per_copied_runtime")

      yield* Effect.promise(() => fs.mkdir(source, { recursive: true }))
      yield* Effect.promise(() =>
        writeSessionStore({
          id: sessionID,
          slug: "copied-pending-runtime",
          version: "test",
          projectID: "proj_copied_runtime",
          directory: source,
          path: "source",
          title: "Copied pending runtime",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 1, updated: 2 },
        } as any),
      )
      yield* Effect.promise(() =>
        appendSessionJsonl(
          {
            id: sessionID,
            directory: source,
          } as any,
          {
            type: "question.asked",
            question: {
              id: questionID,
              sessionID,
              questions: [
                {
                  question: "Restore copied question?",
                  header: "Copy",
                  options: [{ label: "Yes", description: "Keep both pending entries" }],
                },
              ],
            },
          },
        ),
      )
      yield* Effect.promise(() =>
        appendSessionJsonl(
          {
            id: sessionID,
            directory: source,
          } as any,
          {
            type: "permission.asked",
            permission: {
              id: permissionID,
              sessionID,
              permission: "bash",
              patterns: ["echo copied"],
              metadata: {},
              always: [],
            },
          },
        ),
      )
      yield* Effect.promise(() => fs.cp(path.join(source, ".agents"), path.join(target, ".agents"), { recursive: true }))

      const questions = yield* Question.Service
      const permissions = yield* Permission.Service

      expect((yield* questions.list()).map((item) => item.id)).toEqual([questionID, questionID])
      expect((yield* permissions.list()).map((item) => item.id)).toEqual([permissionID, permissionID])
    }),
  )

  it.instance("writes restored pending replies back to their containing directory", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const source = path.join(instance.directory, "source-writeback")
      const target = path.join(instance.directory, "target-writeback")
      const sessionID = "ses_copied_pending_writeback" as SessionID
      const questionID = QuestionID.ascending("que_copied_writeback")
      const permissionID = PermissionV1.ID.ascending("per_copied_writeback")

      yield* Effect.promise(() => fs.mkdir(source, { recursive: true }))
      yield* Effect.promise(() =>
        writeSessionStore({
          id: sessionID,
          slug: "copied-pending-writeback",
          version: "test",
          projectID: "proj_copied_writeback",
          directory: source,
          path: "source-writeback",
          title: "Copied pending writeback",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 1, updated: 2 },
        } as any),
      )
      yield* Effect.promise(() => fs.cp(path.join(source, ".agents"), path.join(target, ".agents"), { recursive: true }))
      yield* Effect.promise(() =>
        appendSessionJsonl(
          {
            id: sessionID,
            directory: target,
          } as any,
          {
            type: "question.asked",
            question: {
              id: questionID,
              sessionID,
              questions: [
                {
                  question: "Write reply to target?",
                  header: "Target",
                  options: [{ label: "Yes", description: "Append the reply to target" }],
                },
              ],
            },
          },
        ),
      )
      yield* Effect.promise(() =>
        appendSessionJsonl(
          {
            id: sessionID,
            directory: target,
          } as any,
          {
            type: "permission.asked",
            permission: {
              id: permissionID,
              sessionID,
              permission: "bash",
              patterns: ["echo target"],
              metadata: {},
              always: [],
            },
          },
        ),
      )

      const questions = yield* Question.Service
      const permissions = yield* Permission.Service

      expect((yield* questions.list()).map((item) => item.id)).toEqual([questionID])
      expect((yield* permissions.list()).map((item) => item.id)).toEqual([permissionID])

      yield* questions.reply({ requestID: questionID, answers: [["Yes"]] })
      yield* permissions.reply({ requestID: permissionID, reply: "once" })

      const sourceRaw = yield* Effect.promise(() =>
        fs.readFile(path.join(source, ".agents", "atree", "sessions", sessionID, "session.jsonl"), "utf8"),
      )
      const targetRaw = yield* Effect.promise(() =>
        fs.readFile(path.join(target, ".agents", "atree", "sessions", sessionID, "session.jsonl"), "utf8"),
      )

      expect(sourceRaw).not.toContain("question.replied")
      expect(sourceRaw).not.toContain("permission.replied")
      expect(targetRaw).toContain("question.replied")
      expect(targetRaw).toContain("permission.replied")
    }),
  )

  it.instance("writes newly asked question and permission replies to their explicit directory", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const source = path.join(instance.directory, "source-new-writeback")
      const target = path.join(instance.directory, "target-new-writeback")
      const sessionID = "ses_new_pending_writeback" as SessionID

      yield* Effect.promise(() => fs.mkdir(source, { recursive: true }))
      yield* Effect.promise(() =>
        writeSessionStore({
          id: sessionID,
          slug: "new-pending-writeback",
          version: "test",
          projectID: "proj_new_writeback",
          directory: source,
          path: "source-new-writeback",
          title: "New pending writeback",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 1, updated: 2 },
        } as any),
      )
      yield* Effect.promise(() => fs.cp(path.join(source, ".agents"), path.join(target, ".agents"), { recursive: true }))

      const questions = yield* Question.Service
      const permissions = yield* Permission.Service
      const events = yield* EventV2Bridge.Service
      const eventDirectories: string[] = []
      const off = yield* events.listen((event) => {
        if (
          event.type === "question.asked" ||
          event.type === "question.replied" ||
          event.type === "permission.asked" ||
          event.type === "permission.replied"
        ) {
          eventDirectories.push(event.location?.directory ?? "")
        }
        return Effect.void
      })
      yield* Effect.addFinalizer(() => off)

      const questionFiber = yield* questions
        .ask({
          sessionID,
          directory: target,
          questions: [
            {
              question: "Write new question reply to target?",
              header: "Target",
              options: [{ label: "Yes", description: "Append to target" }],
            },
          ],
        })
        .pipe(Effect.forkScoped)
      const pendingQuestion = yield* waitFor(questions.list().pipe(Effect.map((items) => items[0])))
      yield* questions.reply({ requestID: pendingQuestion.id, answers: [["Yes"]] })
      yield* Fiber.join(questionFiber)

      const permissionFiber = yield* permissions
        .ask({
          sessionID,
          directory: target,
          permission: "bash",
          patterns: ["echo target"],
          metadata: {},
          always: [],
          ruleset: [],
        })
        .pipe(Effect.forkScoped)
      const pendingPermission = yield* waitFor(permissions.list().pipe(Effect.map((items) => items[0])))
      yield* permissions.reply({ requestID: pendingPermission.id, reply: "once" })
      yield* Fiber.join(permissionFiber)

      const sourceRaw = yield* Effect.promise(() =>
        fs.readFile(path.join(source, ".agents", "atree", "sessions", sessionID, "session.jsonl"), "utf8"),
      )
      const targetRaw = yield* Effect.promise(() =>
        fs.readFile(path.join(target, ".agents", "atree", "sessions", sessionID, "session.jsonl"), "utf8"),
      )

      expect(sourceRaw).not.toContain("question.asked")
      expect(sourceRaw).not.toContain("question.replied")
      expect(sourceRaw).not.toContain("permission.asked")
      expect(sourceRaw).not.toContain("permission.replied")
      expect(targetRaw).toContain("question.asked")
      expect(targetRaw).toContain("question.replied")
      expect(targetRaw).toContain("permission.asked")
      expect(targetRaw).toContain("permission.replied")
      expect(eventDirectories).toEqual([target, target, target, target])
    }),
  )

  it.instance("records pending question and permission decisions in session.jsonl", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const questions = yield* Question.Service
      const permissions = yield* Permission.Service
      const instance = yield* TestInstance

      const session = yield* sessions.create({ title: "interaction events" })
      const beforeUpdated = (yield* Effect.promise(() => readSessionStore(instance.directory, session.id)))!.time.updated

      const questionFiber = yield* questions
        .ask({
          sessionID: session.id,
          questions: [
            {
              question: "Which path should atree take?",
              header: "Path",
              options: [{ label: "Local", description: "Use local directory state" }],
            },
          ],
        })
        .pipe(Effect.forkScoped)
      const pendingQuestion = yield* waitFor(questions.list().pipe(Effect.map((items) => items[0])))
      yield* questions.reply({ requestID: pendingQuestion.id, answers: [["Local"]] })
      expect(yield* Fiber.join(questionFiber)).toEqual([["Local"]])

      const permissionFiber = yield* permissions
        .ask({
          id: PermissionV1.ID.make("per_atree_jsonl"),
          sessionID: session.id,
          permission: "bash",
          patterns: ["echo atree"],
          metadata: {},
          always: [],
          ruleset: [],
        })
        .pipe(Effect.forkScoped)
      const pendingPermission = yield* waitFor(permissions.list().pipe(Effect.map((items) => items[0])))
      yield* permissions.reply({ requestID: pendingPermission.id, reply: "once" })
      yield* Fiber.join(permissionFiber)

      const raw = yield* Effect.promise(() =>
        fs.readFile(path.join(instance.directory, ".agents", "atree", "sessions", session.id, "session.jsonl"), "utf8"),
      )
      const entries = raw
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, any>)

      expect(entries).toContainEqual(
        expect.objectContaining({
          type: "question.asked",
          question: expect.objectContaining({ id: pendingQuestion.id, sessionID: session.id }),
        }),
      )
      expect(entries).toContainEqual(
        expect.objectContaining({
          type: "question.replied",
          sessionID: session.id,
          requestID: pendingQuestion.id,
          answers: [["Local"]],
        }),
      )
      expect(entries).toContainEqual(
        expect.objectContaining({
          type: "permission.asked",
          permission: expect.objectContaining({ id: pendingPermission.id, sessionID: session.id }),
        }),
      )
      expect(entries).toContainEqual(
        expect.objectContaining({
          type: "permission.replied",
          sessionID: session.id,
          requestID: pendingPermission.id,
          reply: "once",
        }),
      )
      const stored = yield* Effect.promise(() => readSessionStore(instance.directory, session.id))
      expect(stored?.time.updated).toBeGreaterThan(beforeUpdated)
    }),
  )

  it.instance("persists session identity fields in directory metadata without SQLite cache", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const instance = yield* TestInstance
      const workspaceID = WorkspaceV2.ID.ascending("wrk_atree_identity")

      const session = yield* sessions.create({
        title: "metadata identity",
        workspaceID,
        metadata: { icon: "🧭" },
      })
      const cached = yield* sessions.get(session.id)
      const compactingAt = Date.now()

      yield* Effect.promise(() =>
        writeSessionStore({
          ...cached,
          time: {
            ...cached.time,
            compacting: compactingAt,
          },
        }),
      )

      const stored = yield* Effect.promise(() => readSessionStore(instance.directory, session.id))
      expect(stored?.projectID).toBe(cached.projectID)
      expect(stored?.workspaceID).toBe(workspaceID)
      expect(stored?.time.compacting).toBe(compactingAt)
      expect(stored?.metadata).toEqual({ icon: "🧭" })
    }),
  )

  it.instance("filters file-backed directory sessions by workspace without SQLite rows", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const instance = yield* TestInstance
      const { db } = yield* Database.Service
      const workspaceA = WorkspaceV2.ID.ascending("wrk_atree_filter_a")
      const workspaceB = WorkspaceV2.ID.ascending("wrk_atree_filter_b")

      const sessionA = yield* sessions.create({ title: "workspace a", workspaceID: workspaceA })
      const sessionB = yield* sessions.create({ title: "workspace b", workspaceID: workspaceB })

      yield* db
        .delete(SessionTable)
        .where(and(eq(SessionTable.directory, instance.directory)))
        .run()
        .pipe(Effect.orDie)

      const listA = yield* sessions.list({ directory: instance.directory, workspaceID: workspaceA, archived: true })
      const listB = yield* sessions.list({ directory: instance.directory, workspaceID: workspaceB, archived: true })

      expect(listA.map((session) => session.id)).toEqual([sessionA.id])
      expect(listB.map((session) => session.id)).toEqual([sessionB.id])
    }),
  )

  it.instance("recovers session diff summary from session.jsonl without SQLite or meta.yaml", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const instance = yield* TestInstance
      const { db } = yield* Database.Service

      const session = yield* sessions.create({ title: "diff from jsonl" })
      const diff = [{ file: "notes.md", additions: 3, deletions: 1, status: "modified" as const, patch: "@@ -1 +1" }]

      yield* Effect.promise(() =>
        appendSessionJsonl(session, {
          type: "session.diff",
          sessionID: session.id,
          diff,
        }),
      )
      yield* db
        .delete(SessionTable)
        .where(and(eq(SessionTable.id, session.id), eq(SessionTable.directory, instance.directory)))
        .run()
        .pipe(Effect.orDie)
      yield* Effect.promise(() =>
        fs.rm(path.join(instance.directory, ".agents", "atree", "sessions", session.id, "meta.yaml"), {
          force: true,
        }),
      )

      const restoredDiff = yield* sessions.diff(session.id, { directory: instance.directory })
      expect(restoredDiff).toEqual(diff)
    }),
  )

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

  it.instance("continues mutating directory-backed session metadata after SQLite projection is removed", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const instance = yield* TestInstance
      const { db } = yield* Database.Service

      const session = yield* sessions.create({ title: "file source mutations", metadata: { icon: "🧭" } })
      yield* db
        .delete(SessionTable)
        .where(and(eq(SessionTable.id, session.id), eq(SessionTable.directory, instance.directory)))
        .run()
        .pipe(Effect.orDie)

      yield* sessions.setTitle({
        sessionID: session.id,
        directory: instance.directory,
        title: "mutated from file source",
      })
      yield* sessions.setMetadata({
        sessionID: session.id,
        directory: instance.directory,
        metadata: { icon: "🌲" },
      })
      yield* sessions.setArchived({ sessionID: session.id, directory: instance.directory, time: 1234 })
      yield* sessions.setArchived({ sessionID: session.id, directory: instance.directory, time: null })

      const stored = yield* Effect.promise(() => readSessionStore(instance.directory, session.id))
      expect(stored?.title).toBe("mutated from file source")
      expect(stored?.metadata).toEqual({ icon: "🌲" })
      expect(stored?.time.archived).toBeUndefined()

      const row = yield* db
        .select()
        .from(SessionTable)
        .where(and(eq(SessionTable.id, session.id), eq(SessionTable.directory, instance.directory)))
        .get()
        .pipe(Effect.orDie)
      expect(row?.title).toBe("mutated from file source")
      expect(row?.metadata).toBeNull()
      expect(row?.time_archived).toBeNull()

      const raw = yield* Effect.promise(() =>
        fs.readFile(path.join(instance.directory, ".agents", "atree", "sessions", session.id, "session.jsonl"), "utf8"),
      )
      const entries = raw
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, any>)
      expect(entries).toContainEqual(
        expect.objectContaining({
          type: "session.updated",
          sessionID: session.id,
          patch: { title: "mutated from file source" },
        }),
      )
      expect(entries).toContainEqual(
        expect.objectContaining({
          type: "session.updated",
          sessionID: session.id,
          patch: { metadata: { icon: "🌲" } },
        }),
      )
      expect(entries).toContainEqual(
        expect.objectContaining({
          type: "session.updated",
          sessionID: session.id,
          patch: { time: { archived: 1234 } },
        }),
      )
      expect(entries).toContainEqual(
        expect.objectContaining({
          type: "session.updated",
          sessionID: session.id,
          patch: { time: { archived: null } },
        }),
      )
    }),
  )

  it.instance("continues mutating directory-backed messages after SQLite projection is removed", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const instance = yield* TestInstance
      const { db } = yield* Database.Service

      const session = yield* sessions.create({ title: "file message mutations" })
      yield* db
        .delete(SessionTable)
        .where(and(eq(SessionTable.id, session.id), eq(SessionTable.directory, instance.directory)))
        .run()
        .pipe(Effect.orDie)

      const messageID = MessageID.ascending()
      const partID = PartID.ascending()
      yield* sessions.updateMessage(
        {
          id: messageID,
          sessionID: session.id,
          role: "user",
          time: { created: Date.now() },
          agent: "user",
          model: { providerID: "test", modelID: "test" },
          tools: {},
          mode: "",
        } as unknown as SessionV1.Info,
        { directory: instance.directory },
      )
      yield* sessions.updatePart(
        {
          id: partID,
          messageID,
          sessionID: session.id,
          type: "text",
          text: "message appended after SQLite projection removal",
        },
        { directory: instance.directory },
      )

      const messages = yield* sessions.messages({ sessionID: session.id, directory: instance.directory })
      expect(messages.find((message) => message.info.id === messageID)?.parts[0]).toMatchObject({
        id: partID,
        type: "text",
        text: "message appended after SQLite projection removal",
      })

      yield* sessions.removePart({ sessionID: session.id, messageID, partID, directory: instance.directory })
      const withoutPart = yield* sessions.messages({ sessionID: session.id, directory: instance.directory })
      expect(withoutPart.find((message) => message.info.id === messageID)?.parts).toEqual([])

      yield* sessions.removeMessage({ sessionID: session.id, messageID, directory: instance.directory })
      const withoutMessage = yield* sessions.messages({ sessionID: session.id, directory: instance.directory })
      expect(withoutMessage.find((message) => message.info.id === messageID)).toBeUndefined()
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

  it.instance("removing a copied scheduled session does not clear the source directory schedule cache", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const schedules = yield* Schedule.Service
      const source = yield* TestInstance
      const target = yield* Effect.acquireRelease(
        Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "atree-remove-scheduled-target-"))),
        (dir) => Effect.promise(() => fs.rm(dir, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      const { db } = yield* Database.Service

      const session = yield* sessions.create({ title: "copied scheduled delete" })
      const schedule = yield* schedules.create({
        sessionID: session.id,
        kind: "once",
        runAt: Date.now() + 120_000,
        message: "source schedule should survive copied removal",
      })
      const sourceBeforeRemove = yield* Effect.promise(() => readSessionScheduleState(source.directory, session.id))
      const rowBeforeRemove = yield* db
        .select({ id: ScheduleTable.id })
        .from(ScheduleTable)
        .where(eq(ScheduleTable.id, schedule.id))
        .get()
        .pipe(Effect.orDie)
      expect(rowBeforeRemove?.id).toBe(schedule.id)
      yield* Effect.promise(() =>
        fs.cp(path.join(source.directory, ".agents"), path.join(target, ".agents"), { recursive: true }),
      )

      yield* sessions.remove(session.id, { directory: target })

      expect(yield* Effect.promise(() => readSessionStore(target, session.id))).toBeUndefined()
      expect(yield* Effect.promise(() => readSessionStore(source.directory, session.id))).not.toBeUndefined()
      expect(yield* Effect.promise(() => readSessionScheduleState(source.directory, session.id))).toEqual(
        sourceBeforeRemove,
      )
      const restored = yield* schedules.list(session.id, { directory: source.directory })
      expect(restored.map((item) => item.id)).toContain(schedule.id)
    }),
  )

  it.instance("archiving a scheduled session clears its directory schedule state immediately", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const schedules = yield* Schedule.Service
      const instance = yield* TestInstance
      const { db } = yield* Database.Service

      const session = yield* sessions.create({ title: "scheduled archive" })
      const schedule = yield* schedules.create({
        sessionID: session.id,
        kind: "once",
        runAt: Date.now() + 120_000,
        message: "should be cleared when archived",
      })

      expect(yield* Effect.promise(() => readSessionScheduleState(instance.directory, session.id))).toHaveLength(1)
      expect(
        yield* db
          .select({ id: ScheduleTable.id })
          .from(ScheduleTable)
          .where(eq(ScheduleTable.id, schedule.id))
          .get()
          .pipe(Effect.orDie),
      ).toBeDefined()

      yield* sessions.setArchived({ sessionID: session.id, time: Date.now() })

      expect(yield* Effect.promise(() => readSessionScheduleState(instance.directory, session.id))).toEqual([])
      const jsonl = yield* Effect.promise(() =>
        fs.readFile(path.join(instance.directory, ".agents", "atree", "sessions", session.id, "session.jsonl"), "utf8"),
      )
      const entries = jsonl
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>)
      expect(entries).toContainEqual(
        expect.objectContaining({
          type: "schedule.deleted",
          scheduleID: schedule.id,
          sessionID: session.id,
          reason: "archived",
        }),
      )
      const row = yield* db
        .select({ id: ScheduleTable.id })
        .from(ScheduleTable)
        .where(eq(ScheduleTable.id, schedule.id))
        .get()
        .pipe(Effect.orDie)
      expect(row).toBeUndefined()
    }),
  )

  it.instance("archiving a copied scheduled session clears only the target directory schedule state", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const schedules = yield* Schedule.Service
      const source = yield* TestInstance
      const target = yield* Effect.acquireRelease(
        Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "atree-archive-scheduled-target-"))),
        (dir) => Effect.promise(() => fs.rm(dir, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      const { db } = yield* Database.Service

      const session = yield* sessions.create({ title: "copied scheduled archive" })
      const schedule = yield* schedules.create({
        sessionID: session.id,
        kind: "once",
        runAt: Date.now() + 120_000,
        message: "source schedule should survive copied archive",
      })
      const sourceBeforeArchive = yield* Effect.promise(() => readSessionScheduleState(source.directory, session.id))
      const rowBeforeArchive = yield* db
        .select({ id: ScheduleTable.id })
        .from(ScheduleTable)
        .where(eq(ScheduleTable.id, schedule.id))
        .get()
        .pipe(Effect.orDie)
      expect(rowBeforeArchive?.id).toBe(schedule.id)
      yield* Effect.promise(() =>
        fs.cp(path.join(source.directory, ".agents"), path.join(target, ".agents"), { recursive: true }),
      )

      yield* sessions.setArchived({ sessionID: session.id, directory: target, time: Date.now() })

      expect(yield* Effect.promise(() => readSessionScheduleState(target, session.id))).toEqual([])
      expect(yield* Effect.promise(() => readSessionScheduleState(source.directory, session.id))).toEqual(
        sourceBeforeArchive,
      )
      const restored = yield* schedules.list(session.id, { directory: source.directory })
      expect(restored.map((item) => item.id)).toContain(schedule.id)
    }),
  )

  it.instance("archiving a file-backed session clears schedule state without database rows", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const instance = yield* TestInstance
      const { db } = yield* Database.Service
      const now = Date.now()
      const sessionID = "ses_file_archive_clears_schedule" as SessionID
      const scheduleID = "sch_file_archive_clears_schedule"

      yield* Effect.promise(() =>
        writeSessionStore({
          id: sessionID,
          slug: "file-archive-clears-schedule",
          version: "test",
          projectID: "proj_file",
          directory: instance.directory,
          path: ".",
          title: "File archive clears schedule",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: now, updated: now },
        } as any),
      )
      yield* Effect.promise(() =>
        writeSessionScheduleState(instance.directory, sessionID, [
          {
            id: scheduleID,
            sessionID,
            kind: "once",
            expression: "",
            runAt: now + 120_000,
            message: "should be cleared from file state",
            createdAt: now,
            lastRanAt: null,
            lastRunStatus: null,
            nextRun: now + 120_000,
          },
        ]),
      )

      yield* sessions.setArchived({ sessionID, directory: instance.directory, time: now + 1 })

      expect(yield* Effect.promise(() => readSessionScheduleState(instance.directory, sessionID))).toEqual([])
      const row = yield* db
        .select({ id: ScheduleTable.id })
        .from(ScheduleTable)
        .where(eq(ScheduleTable.id, scheduleID))
        .get()
        .pipe(Effect.orDie)
      expect(row).toBeUndefined()
    }),
  )

  it.instance("archiving a nested file-backed session from the persisted root clears schedule state", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const instance = yield* TestInstance
      const data = yield* Effect.acquireRelease(
        Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "atree-root-archive-data-"))),
        (dir) => Effect.promise(() => fs.rm(dir, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      const previousData = Global.Path.data
      ;(Global.Path as { data: string }).data = data
      yield* Effect.addFinalizer(() => Effect.sync(() => ((Global.Path as { data: string }).data = previousData)))

      const now = Date.now()
      const directory = path.join(instance.directory, "nested", "archive-node")
      const sessionID = "ses_root_archive_clears_schedule" as SessionID
      const scheduleID = "sch_root_archive_clears_schedule"
      yield* Effect.promise(() => fs.mkdir(directory, { recursive: true }))
      yield* Effect.promise(() => writeWorkspaceRoot(instance.directory))
      yield* Effect.promise(() =>
        writeSessionStore({
          id: sessionID,
          slug: "root-archive-clears-schedule",
          version: "test",
          projectID: "proj_file",
          directory,
          path: "nested/archive-node",
          title: "Root archive clears schedule",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: now, updated: now },
        } as any),
      )
      yield* Effect.promise(() =>
        writeSessionScheduleState(directory, sessionID, [
          {
            id: scheduleID,
            sessionID,
            kind: "once",
            expression: "",
            runAt: now + 120_000,
            message: "clear from persisted root",
            createdAt: now,
            lastRanAt: null,
            lastRunStatus: null,
            nextRun: now + 120_000,
          },
        ]),
      )

      yield* sessions.setArchived({ sessionID, time: now + 1 })

      expect((yield* Effect.promise(() => readSessionStore(directory, sessionID)))?.time.archived).toBe(now + 1)
      expect(yield* Effect.promise(() => readSessionScheduleState(directory, sessionID))).toEqual([])
      const jsonl = yield* Effect.promise(() =>
        fs.readFile(path.join(directory, ".agents", "atree", "sessions", sessionID, "session.jsonl"), "utf8"),
      )
      const entries = jsonl
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>)
      expect(entries).toContainEqual(
        expect.objectContaining({
          type: "schedule.deleted",
          scheduleID,
          sessionID,
          reason: "archived",
        }),
      )
    }),
  )

  it.instance("removing a nested file-backed session from the persisted root deletes schedule state", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const instance = yield* TestInstance
      const data = yield* Effect.acquireRelease(
        Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "atree-root-remove-data-"))),
        (dir) => Effect.promise(() => fs.rm(dir, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      const previousData = Global.Path.data
      ;(Global.Path as { data: string }).data = data
      yield* Effect.addFinalizer(() => Effect.sync(() => ((Global.Path as { data: string }).data = previousData)))

      const now = Date.now()
      const directory = path.join(instance.directory, "nested", "remove-node")
      const sessionID = "ses_root_remove_clears_schedule" as SessionID
      const scheduleID = "sch_root_remove_clears_schedule"
      yield* Effect.promise(() => fs.mkdir(directory, { recursive: true }))
      yield* Effect.promise(() => writeWorkspaceRoot(instance.directory))
      yield* Effect.promise(() =>
        writeSessionStore({
          id: sessionID,
          slug: "root-remove-clears-schedule",
          version: "test",
          projectID: "proj_file",
          directory,
          path: "nested/remove-node",
          title: "Root remove clears schedule",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: now, updated: now },
        } as any),
      )
      yield* Effect.promise(() =>
        writeSessionScheduleState(directory, sessionID, [
          {
            id: scheduleID,
            sessionID,
            kind: "once",
            expression: "",
            runAt: now + 120_000,
            message: "delete from persisted root",
            createdAt: now,
            lastRanAt: null,
            lastRunStatus: null,
            nextRun: now + 120_000,
          },
        ]),
      )

      yield* sessions.remove(sessionID)

      expect(yield* Effect.promise(() => readSessionStore(directory, sessionID))).toBeUndefined()
      expect(yield* Effect.promise(() => readSessionScheduleState(directory, sessionID))).toEqual([])
      expect(
        yield* Effect.promise(() =>
          fs.stat(path.join(directory, ".agents", "atree", "sessions", sessionID)).then(
            () => true,
            () => false,
          ),
        ),
      ).toBe(false)
    }),
  )
})
