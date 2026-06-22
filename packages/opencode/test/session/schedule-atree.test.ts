import { describe, expect } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { Database } from "@opencode-ai/core/database/database"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { Effect, Exit, Layer } from "effect"
import { eq } from "drizzle-orm"
import { readSessionScheduleState, writeSessionScheduleState } from "../../src/atree/schedule-store"
import { readSessionStore, writeSessionStore } from "../../src/atree/session-store"
import { writeWorkspaceRoot } from "../../src/atree/state"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Schedule } from "../../src/session/schedule"
import { ScheduleTable } from "../../src/session/schedule.sql"
import type { SessionID } from "../../src/session/schema"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { InstanceState } from "@/effect/instance-state"

const database = Database.layerFromPath(":memory:")
const events = EventV2Bridge.defaultLayer
const baseLayer = Layer.mergeAll(database, events)
const schedule = Schedule.layer.pipe(Layer.provide(baseLayer))
const it = testEffect(Layer.mergeAll(baseLayer, schedule))
const baseIt = testEffect(baseLayer)

const tempdir = Effect.acquireRelease(
  Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "atree-schedule-restore-"))),
  (dir) => Effect.promise(() => fs.rm(dir, { recursive: true, force: true })).pipe(Effect.ignore),
)

describe("atree schedule restore", () => {
  it.effect(
    "restores a schedule from directory state when the DB cache is empty",
    Effect.gen(function* () {
      const directory = yield* tempdir
      const { db } = yield* Database.Service
      const sessionID = "ses_restore" as SessionID
      const now = Date.now()

      yield* db
        .insert(ProjectTable)
        .values({
          id: "proj_restore",
          worktree: directory,
          vcs: "git",
          name: "restore",
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
          project_id: "proj_restore",
          slug: "restore",
          directory,
          title: "Restore",
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
          slug: "restore",
          version: "test",
          projectID: "proj_restore" as never,
          directory,
          title: "Restore",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: now, updated: now },
        }),
      )

      yield* Effect.promise(() =>
        writeSessionScheduleState(directory, sessionID, [
          {
            id: "sch_restore",
            sessionID,
            kind: "once",
            expression: "",
            runAt: now + 60_000,
            message: "restore me",
            createdAt: now,
            lastRanAt: null,
            lastRunStatus: null,
            nextRun: now + 60_000,
          },
        ]),
      )

      const schedules = yield* Schedule.Service.use((schedule) => schedule.list(sessionID))
      expect(schedules).toHaveLength(1)
      expect(schedules[0]).toMatchObject({ id: "sch_restore", sessionID, message: "restore me" })

      const row = yield* db
        .select()
        .from(ScheduleTable)
        .where(eq(ScheduleTable.id, "sch_restore" as never))
        .get()
        .pipe(Effect.orDie)
      expect(row?.message).toBe("restore me")
    }),
  )

  it.instance(
    "restores a schedule for a file-backed session without a DB session row",
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const sessionID = "ses_file_schedule" as SessionID
      const now = Date.now()

      yield* Effect.promise(() =>
        writeSessionStore({
          id: sessionID,
          slug: "file-schedule",
          version: "test",
          projectID: "proj_file",
          directory: instance.directory,
          path: ".",
          title: "File schedule",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: now, updated: now },
        } as any),
      )
      yield* Effect.promise(() =>
        writeSessionScheduleState(instance.directory, sessionID, [
          {
            id: "sch_file",
            sessionID,
            kind: "once",
            expression: "",
            runAt: now + 60_000,
            message: "file-backed schedule",
            createdAt: now,
            lastRanAt: null,
            lastRunStatus: null,
            nextRun: now + 60_000,
          },
        ]),
      )

      const schedules = yield* Schedule.Service.use((schedule) => schedule.list(sessionID))
      expect(schedules).toHaveLength(1)
      expect(schedules[0]).toMatchObject({ id: "sch_file", sessionID, message: "file-backed schedule" })
    }),
  )

  it.instance(
    "restores file-backed schedules for a directory",
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const sessionID = "ses_file_directory_schedule" as SessionID
      const now = Date.now()

      yield* Effect.promise(() =>
        writeSessionStore({
          id: sessionID,
          slug: "file-directory-schedule",
          version: "test",
          projectID: "proj_file",
          directory: instance.directory,
          path: ".",
          title: "File directory schedule",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: now, updated: now },
        } as any),
      )
      yield* Effect.promise(() =>
        writeSessionScheduleState(instance.directory, sessionID, [
          {
            id: "sch_file_directory",
            sessionID,
            kind: "once",
            expression: "",
            runAt: now + 60_000,
            message: "restore directory schedule",
            createdAt: now,
            lastRanAt: null,
            lastRunStatus: null,
            nextRun: now + 60_000,
          },
        ]),
      )

      yield* Schedule.Service.use((schedule) => schedule.restoreDirectory(instance.directory))

      const row = yield* Database.Service.use(({ db }) =>
        db
          .select()
          .from(ScheduleTable)
          .where(eq(ScheduleTable.id, "sch_file_directory" as never))
          .get()
          .pipe(Effect.orDie),
      )
      expect(row?.session_id).toBe(sessionID)
      expect(row?.message).toBe("restore directory schedule")
    }),
  )

  it.effect(
    "restores file-backed schedules for an explicit directory without an instance context",
    Effect.gen(function* () {
      const directory = yield* tempdir
      const sessionID = "ses_explicit_directory_schedule" as SessionID
      const now = Date.now()

      yield* Effect.promise(() =>
        writeSessionStore({
          id: sessionID,
          slug: "explicit-directory-schedule",
          version: "test",
          projectID: "proj_file",
          directory,
          path: ".",
          title: "Explicit directory schedule",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: now, updated: now },
        } as any),
      )
      yield* Effect.promise(() =>
        writeSessionScheduleState(directory, sessionID, [
          {
            id: "sch_explicit_directory",
            sessionID,
            kind: "once",
            expression: "",
            runAt: now + 60_000,
            message: "restore without instance",
            createdAt: now,
            lastRanAt: null,
            lastRunStatus: null,
            nextRun: now + 60_000,
          },
        ]),
      )

      yield* Schedule.Service.use((schedule) => schedule.restoreDirectory(directory))

      const row = yield* Database.Service.use(({ db }) =>
        db
          .select()
          .from(ScheduleTable)
          .where(eq(ScheduleTable.id, "sch_explicit_directory" as never))
          .get()
          .pipe(Effect.orDie),
      )
      expect(row?.session_id).toBe(sessionID)
      expect(row?.message).toBe("restore without instance")
    }),
  )

  it.effect(
    "restores file-backed schedules from nested atree directories under a root",
    Effect.gen(function* () {
      const root = yield* tempdir
      const nodeDirectory = path.join(root, "projects", "node")
      const sessionID = "ses_nested_restore_schedule" as SessionID
      const now = Date.now()

      yield* Effect.promise(() => fs.mkdir(nodeDirectory, { recursive: true }))
      yield* Effect.promise(() =>
        writeSessionStore({
          id: sessionID,
          slug: "nested-restore-schedule",
          version: "test",
          projectID: "proj_file",
          directory: nodeDirectory,
          path: "projects/node",
          title: "Nested restore schedule",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: now, updated: now },
        } as any),
      )
      yield* Effect.promise(() =>
        writeSessionScheduleState(nodeDirectory, sessionID, [
          {
            id: "sch_nested_directory",
            sessionID,
            kind: "once",
            expression: "",
            runAt: now + 60_000,
            message: "restore nested schedule",
            createdAt: now,
            lastRanAt: null,
            lastRunStatus: null,
            nextRun: now + 60_000,
          },
        ]),
      )

      yield* Schedule.Service.use((schedule) => schedule.restoreDirectory(root))

      const row = yield* Database.Service.use(({ db }) =>
        db
          .select()
          .from(ScheduleTable)
          .where(eq(ScheduleTable.id, "sch_nested_directory" as never))
          .get()
          .pipe(Effect.orDie),
      )
      expect(row?.session_id).toBe(sessionID)
      expect(row?.message).toBe("restore nested schedule")

      const listed = yield* Schedule.Service.use((schedule) => schedule.list(sessionID, { directory: nodeDirectory }))
      expect(String(listed[0]?.id)).toBe("sch_nested_directory")
    }),
  )

  baseIt.effect(
    "restores persisted root file-backed schedules when the service starts",
    Effect.gen(function* () {
      const data = yield* Effect.acquireRelease(
        Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "atree-schedule-start-data-"))),
        (dir) => Effect.promise(() => fs.rm(dir, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      const root = yield* tempdir
      const directory = path.join(root, "nodes", "daily")
      const sessionID = "ses_start_restore_schedule" as SessionID
      const now = Date.now()
      const previousData = Global.Path.data
      ;(Global.Path as { data: string }).data = data
      yield* Effect.addFinalizer(() => Effect.sync(() => ((Global.Path as { data: string }).data = previousData)))

      yield* Effect.promise(() => fs.mkdir(directory, { recursive: true }))
      yield* Effect.promise(() => writeWorkspaceRoot(root))
      yield* Effect.promise(() =>
        writeSessionStore({
          id: sessionID,
          slug: "start-restore-schedule",
          version: "test",
          projectID: "proj_file",
          directory,
          path: "nodes/daily",
          title: "Start restore schedule",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: now, updated: now },
        } as any),
      )
      yield* Effect.promise(() =>
        writeSessionScheduleState(directory, sessionID, [
          {
            id: "sch_start_restore",
            sessionID,
            kind: "once",
            expression: "",
            runAt: now + 60_000,
            message: "restore on service start",
            createdAt: now,
            lastRanAt: null,
            lastRunStatus: null,
            nextRun: now + 60_000,
          },
        ]),
      )

      yield* Schedule.Service.use(() => Effect.void).pipe(Effect.provide(Schedule.layer))

      const row = yield* Database.Service.use(({ db }) =>
        db
          .select()
          .from(ScheduleTable)
          .where(eq(ScheduleTable.id, "sch_start_restore" as never))
          .get()
          .pipe(Effect.orDie),
      )
      expect(row?.session_id).toBe(sessionID)
      expect(row?.message).toBe("restore on service start")
    }),
  )

  it.effect(
    "lists schedules for an explicit directory without a database session row",
    Effect.gen(function* () {
      const directory = yield* tempdir
      const sessionID = "ses_explicit_list_schedule" as SessionID
      const now = Date.now()

      yield* Effect.promise(() =>
        writeSessionStore({
          id: sessionID,
          slug: "explicit-list-schedule",
          version: "test",
          projectID: "proj_file",
          directory,
          path: ".",
          title: "Explicit list schedule",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: now, updated: now },
        } as any),
      )
      yield* Effect.promise(() =>
        writeSessionScheduleState(directory, sessionID, [
          {
            id: "sch_explicit_list",
            sessionID,
            kind: "once",
            expression: "",
            runAt: now + 60_000,
            message: "list with explicit directory",
            createdAt: now,
            lastRanAt: null,
            lastRunStatus: null,
            nextRun: now + 60_000,
          },
        ]),
      )

      const schedules = yield* Schedule.Service.use((schedule) => schedule.list(sessionID, { directory }))
      expect(schedules).toHaveLength(1)
      expect(schedules[0]).toMatchObject({
        id: "sch_explicit_list",
        sessionID,
        message: "list with explicit directory",
      })

      const row = yield* Database.Service.use(({ db }) =>
        db
          .select()
          .from(ScheduleTable)
          .where(eq(ScheduleTable.id, "sch_explicit_list" as never))
          .get()
          .pipe(Effect.orDie),
      )
      expect(row?.session_id).toBe(sessionID)
    }),
  )

  it.effect(
    "does not read or mutate stale database schedules for a missing explicit directory session",
    Effect.gen(function* () {
      const source = yield* tempdir
      const target = yield* tempdir
      const { db } = yield* Database.Service
      const sessionID = "ses_missing_explicit_schedule" as SessionID
      const scheduleID = "sch_missing_explicit_schedule" as Schedule.ID
      const now = Date.now()

      yield* db
        .insert(ProjectTable)
        .values({
          id: "proj_missing_explicit_schedule",
          worktree: source,
          vcs: "git",
          name: "missing explicit schedule",
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
          project_id: "proj_missing_explicit_schedule",
          slug: "missing-explicit-schedule",
          directory: source,
          title: "Missing explicit schedule",
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
        .insert(ScheduleTable)
        .values({
          id: scheduleID,
          session_id: sessionID,
          kind: "once",
          expression: "",
          run_at: now + 60_000,
          message: "stale database schedule",
          created_at: now,
        })
        .run()
        .pipe(Effect.orDie)

      const listed = yield* Schedule.Service.use((schedule) => schedule.list(sessionID, { directory: target }))
      expect(listed).toEqual([])

      yield* Schedule.Service.use((schedule) => schedule.clear(sessionID, { directory: target }))
      const afterClear = yield* db
        .select()
        .from(ScheduleTable)
        .where(eq(ScheduleTable.id, scheduleID))
        .get()
        .pipe(Effect.orDie)
      expect(afterClear?.message).toBe("stale database schedule")

      const deleted = yield* Schedule.Service.use((schedule) =>
        schedule.delete(scheduleID, { directory: target }).pipe(Effect.exit),
      )
      expect(Exit.isFailure(deleted)).toBe(true)
      const afterDelete = yield* db
        .select()
        .from(ScheduleTable)
        .where(eq(ScheduleTable.id, scheduleID))
        .get()
        .pipe(Effect.orDie)
      expect(afterDelete?.message).toBe("stale database schedule")
    }),
  )

  it.effect(
    "does not create a database-only schedule for a missing explicit directory session",
    Effect.gen(function* () {
      const source = yield* tempdir
      const target = yield* tempdir
      const { db } = yield* Database.Service
      const sessionID = "ses_missing_explicit_create_schedule" as SessionID
      const now = Date.now()

      yield* db
        .insert(ProjectTable)
        .values({
          id: "proj_missing_explicit_create_schedule",
          worktree: source,
          vcs: "git",
          name: "missing explicit create schedule",
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
          project_id: "proj_missing_explicit_create_schedule",
          slug: "missing-explicit-create-schedule",
          directory: source,
          title: "Missing explicit create schedule",
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

      const created = yield* Schedule.Service.use((schedule) =>
        schedule
          .create({
            sessionID,
            directory: target,
            kind: "once",
            runAt: now + 60_000,
            message: "should not be created",
          })
          .pipe(Effect.exit),
      )
      expect(Exit.isFailure(created)).toBe(true)

      const rows = yield* db
        .select()
        .from(ScheduleTable)
        .where(eq(ScheduleTable.session_id, sessionID))
        .all()
        .pipe(Effect.orDie)
      expect(rows).toEqual([])
      expect(yield* Effect.promise(() => readSessionScheduleState(target, sessionID))).toEqual([])
    }),
  )

  it.effect(
    "deletes a file-backed schedule from an explicit directory without a database row",
    Effect.gen(function* () {
      const directory = yield* tempdir
      const sessionID = "ses_explicit_delete_schedule" as SessionID
      const now = Date.now()

      yield* Effect.promise(() =>
        writeSessionStore({
          id: sessionID,
          slug: "explicit-delete-schedule",
          version: "test",
          projectID: "proj_file",
          directory,
          path: ".",
          title: "Explicit delete schedule",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: now, updated: now },
        } as any),
      )
      yield* Effect.promise(() =>
        writeSessionScheduleState(directory, sessionID, [
          {
            id: "sch_explicit_delete",
            sessionID,
            kind: "once",
            expression: "",
            runAt: now + 60_000,
            message: "delete with explicit directory",
            createdAt: now,
            lastRanAt: null,
            lastRunStatus: null,
            nextRun: now + 60_000,
          },
        ]),
      )

      yield* Schedule.Service.use((schedule) => schedule.delete("sch_explicit_delete" as never, { directory }))

      expect(yield* Effect.promise(() => readSessionScheduleState(directory, sessionID))).toEqual([])
      const row = yield* Database.Service.use(({ db }) =>
        db
          .select()
          .from(ScheduleTable)
          .where(eq(ScheduleTable.id, "sch_explicit_delete" as never))
          .get()
          .pipe(Effect.orDie),
      )
      expect(row).toBeUndefined()
    }),
  )

  it.effect(
    "deletes a file-backed schedule from the persisted atree root without a directory hint",
    Effect.gen(function* () {
      const data = yield* Effect.acquireRelease(
        Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "atree-schedule-delete-data-"))),
        (dir) => Effect.promise(() => fs.rm(dir, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      const root = yield* tempdir
      const previousData = Global.Path.data
      ;(Global.Path as { data: string }).data = data
      yield* Effect.addFinalizer(() => Effect.sync(() => ((Global.Path as { data: string }).data = previousData)))

      const directory = path.join(root, "nested")
      const sessionID = "ses_root_delete_schedule" as SessionID
      const scheduleID = "sch_root_delete_schedule"
      const now = Date.now()

      yield* Effect.promise(() => fs.mkdir(directory, { recursive: true }))
      yield* Effect.promise(() => writeWorkspaceRoot(root))
      yield* Effect.promise(() =>
        writeSessionStore({
          id: sessionID,
          slug: "root-delete-schedule",
          version: "test",
          projectID: "proj_file",
          directory,
          path: ".",
          title: "Root delete schedule",
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
            runAt: now + 60_000,
            message: "delete from persisted root",
            createdAt: now,
            lastRanAt: null,
            lastRunStatus: null,
            nextRun: now + 60_000,
          },
        ]),
      )

      yield* Schedule.Service.use((schedule) => schedule.delete(scheduleID as never))

      expect(yield* Effect.promise(() => readSessionScheduleState(directory, sessionID))).toEqual([])
      const row = yield* Database.Service.use(({ db }) =>
        db
          .select()
          .from(ScheduleTable)
          .where(eq(ScheduleTable.id, scheduleID as never))
          .get()
          .pipe(Effect.orDie),
      )
      expect(row).toBeUndefined()
    }),
  )

  it.instance(
    "writes copied file-backed schedule state to the explicit target directory",
    Effect.gen(function* () {
      const schedules = yield* Schedule.Service
      const source = yield* TestInstance
      const target = yield* Effect.acquireRelease(
        Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "atree-schedule-copy-target-"))),
        (dir) => Effect.promise(() => fs.rm(dir, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      const { db } = yield* Database.Service
      const sessionID = "ses_copied_schedule" as SessionID
      const now = Date.now()
      const storedSchedule = {
        id: "sch_copied_schedule",
        sessionID,
        kind: "once" as const,
        expression: "",
        runAt: now + 60_000,
        message: "copied schedule",
        createdAt: now,
        lastRanAt: null,
        lastRunStatus: null,
        nextRun: now + 60_000,
      }

      yield* db
        .insert(ProjectTable)
        .values({
          id: "proj_copied_schedule",
          worktree: source.directory,
          vcs: "git",
          name: "copied schedule",
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
          project_id: "proj_copied_schedule",
          slug: "copied-schedule",
          directory: source.directory,
          title: "Copied schedule",
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
          slug: "copied-schedule",
          version: "test",
          projectID: "proj_copied_schedule",
          directory: source.directory,
          path: ".",
          title: "Copied schedule",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: now, updated: now },
        } as any),
      )
      yield* Effect.promise(() => writeSessionScheduleState(source.directory, sessionID, [storedSchedule]))
      yield* Effect.promise(() =>
        fs.cp(path.join(source.directory, ".agents"), path.join(target, ".agents"), { recursive: true }),
      )

      yield* schedules.clear(sessionID, { directory: target })

      expect(yield* Effect.promise(() => readSessionScheduleState(target, sessionID))).toEqual([])
      expect(yield* Effect.promise(() => readSessionScheduleState(source.directory, sessionID))).toEqual([
        storedSchedule,
      ])
    }),
  )

  it.instance(
    "deletes copied file-backed schedule state from the explicit target directory",
    Effect.gen(function* () {
      const schedules = yield* Schedule.Service
      const source = yield* TestInstance
      const target = yield* Effect.acquireRelease(
        Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "atree-schedule-delete-target-"))),
        (dir) => Effect.promise(() => fs.rm(dir, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      const { db } = yield* Database.Service
      const sessionID = "ses_copied_schedule_delete" as SessionID
      const now = Date.now()
      const storedSchedule = {
        id: "sch_copied_schedule_delete",
        sessionID,
        kind: "once" as const,
        expression: "",
        runAt: now + 60_000,
        message: "delete copied schedule",
        createdAt: now,
        lastRanAt: null,
        lastRunStatus: null,
        nextRun: now + 60_000,
      }

      yield* db
        .insert(ProjectTable)
        .values({
          id: "proj_copied_schedule_delete",
          worktree: source.directory,
          vcs: "git",
          name: "copied schedule delete",
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
          project_id: "proj_copied_schedule_delete",
          slug: "copied-schedule-delete",
          directory: source.directory,
          title: "Copied schedule delete",
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
          slug: "copied-schedule-delete",
          version: "test",
          projectID: "proj_copied_schedule_delete",
          directory: source.directory,
          path: ".",
          title: "Copied schedule delete",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: now, updated: now },
        } as any),
      )
      yield* Effect.promise(() => writeSessionScheduleState(source.directory, sessionID, [storedSchedule]))
      yield* Effect.promise(() =>
        fs.cp(path.join(source.directory, ".agents"), path.join(target, ".agents"), { recursive: true }),
      )

      const restored = yield* schedules.list(sessionID, { directory: target })
      expect(restored).toHaveLength(1)
      yield* schedules.delete(storedSchedule.id as Schedule.ID, { directory: target })

      expect(yield* Effect.promise(() => readSessionScheduleState(target, sessionID))).toEqual([])
      expect(yield* Effect.promise(() => readSessionScheduleState(source.directory, sessionID))).toEqual([
        storedSchedule,
      ])
    }),
  )

  it.instance(
    "restores recurring schedule run state from directory state",
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const sessionID = "ses_file_run_state_schedule" as SessionID
      const now = Date.now()
      const lastRanAt = now - 30_000

      yield* Effect.promise(() =>
        writeSessionStore({
          id: sessionID,
          slug: "file-run-state-schedule",
          version: "test",
          projectID: "proj_file",
          directory: instance.directory,
          path: ".",
          title: "File run state schedule",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: now, updated: now },
        } as any),
      )
      yield* Effect.promise(() =>
        writeSessionScheduleState(instance.directory, sessionID, [
          {
            id: "sch_file_run_state",
            sessionID,
            kind: "recurring",
            expression: "* * * * *",
            runAt: null,
            message: "restore run state",
            createdAt: now,
            lastRanAt,
            lastRunStatus: "ran",
            nextRun: now + 60_000,
          },
        ]),
      )

      const schedules = yield* Schedule.Service.use((schedule) => schedule.list(sessionID))
      const state = yield* Effect.promise(() => readSessionScheduleState(instance.directory, sessionID))

      expect(schedules[0]).toMatchObject({
        id: "sch_file_run_state",
        lastRanAt,
        lastRunStatus: "ran",
      })
      expect(state[0]).toMatchObject({
        id: "sch_file_run_state",
        lastRanAt,
        lastRunStatus: "ran",
      })
    }),
  )

  it.instance(
    "creates a schedule for a file-backed session without a DB session row",
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const sessionID = "ses_file_create_schedule" as SessionID
      const now = Date.now()

      yield* Effect.promise(() =>
        writeSessionStore({
          id: sessionID,
          slug: "file-create-schedule",
          version: "test",
          projectID: "proj_file",
          directory: instance.directory,
          path: ".",
          title: "File create schedule",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: now, updated: now },
        } as any),
      )

      const created = yield* Schedule.Service.use((schedule) =>
        schedule.create({
          sessionID,
          kind: "once",
          runAt: now + 60_000,
          message: "created from file-backed session",
        }),
      )

      expect(created).toMatchObject({ sessionID, message: "created from file-backed session" })
      expect(yield* Effect.promise(() => readSessionScheduleState(instance.directory, sessionID))).toHaveLength(1)

      const row = yield* Database.Service.use(({ db }) =>
        db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie),
      )
      expect(row?.directory).toBe(instance.directory)
    }),
  )

  it.effect(
    "creates a schedule for an explicit directory without a database session row",
    Effect.gen(function* () {
      const directory = yield* tempdir
      const sessionID = "ses_explicit_create_schedule" as SessionID
      const now = Date.now()

      yield* Effect.promise(() =>
        writeSessionStore({
          id: sessionID,
          slug: "explicit-create-schedule",
          version: "test",
          projectID: "proj_file",
          directory,
          path: ".",
          title: "Explicit create schedule",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: now, updated: now },
        } as any),
      )

      const created = yield* Schedule.Service.use((schedule) =>
        schedule.create({
          sessionID,
          directory,
          kind: "once",
          runAt: now + 60_000,
          message: "created with explicit directory",
        }),
      )

      expect(created).toMatchObject({ sessionID, kind: "once", message: "created with explicit directory" })
      const stored = yield* Effect.promise(() => readSessionScheduleState(directory, sessionID))
      expect(stored).toHaveLength(1)
      expect(stored[0]).toMatchObject({ id: created.id, message: "created with explicit directory" })
      const row = yield* Database.Service.use(({ db }) =>
        db
          .select()
          .from(ScheduleTable)
          .where(eq(ScheduleTable.id, created.id as never))
          .get()
          .pipe(Effect.orDie),
      )
      expect(row?.session_id).toBe(sessionID)
    }),
  )

  it.effect(
    "appends schedule lifecycle events to the session jsonl in the directory",
    Effect.gen(function* () {
      const directory = yield* tempdir
      const sessionID = "ses_schedule_jsonl_events" as SessionID
      const now = Date.now()

      yield* Effect.promise(() =>
        writeSessionStore({
          id: sessionID,
          slug: "schedule-jsonl-events",
          version: "test",
          projectID: "proj_file",
          directory,
          path: ".",
          title: "Schedule JSONL events",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: now, updated: now },
        } as any),
      )

      const created = yield* Schedule.Service.use((schedule) =>
        schedule.create({
          sessionID,
          directory,
          kind: "recurring",
          expression: "* * * * *",
          message: "record schedule lifecycle in session.jsonl",
        }),
      )
      yield* Schedule.Service.use((schedule) =>
        schedule.recordRun(created.id, sessionID, "ran", now + 1_000, { directory }),
      )
      yield* Schedule.Service.use((schedule) => schedule.delete(created.id, { directory }))

      const raw = yield* Effect.promise(() =>
        fs.readFile(path.join(directory, ".agents", "atree", "sessions", sessionID, "session.jsonl"), "utf8"),
      )
      const entries = raw
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, any>)

      expect(entries.map((entry) => entry.type)).toEqual(["schedule.created", "schedule.ran", "schedule.deleted"])
      expect(entries[0]?.schedule).toMatchObject({
        id: created.id,
        sessionID,
        message: "record schedule lifecycle in session.jsonl",
      })
      expect(entries[1]).toMatchObject({ scheduleID: created.id, sessionID, status: "ran", ranAt: now + 1_000 })
      expect(typeof entries[1]?.nextRun === "number" || entries[1]?.nextRun === null).toBe(true)
      expect(entries[2]).toMatchObject({ scheduleID: created.id, sessionID, reason: "deleted" })
      expect(entries.every((entry) => typeof entry.at === "number")).toBe(true)
      const stored = yield* Effect.promise(() => readSessionStore(directory, sessionID))
      expect(stored?.time.updated).toBeGreaterThanOrEqual(entries[2].at)
      expect(yield* Effect.promise(() => readSessionScheduleState(directory, sessionID))).toEqual([])
    }),
  )

  it.effect(
    "prefers newer schedule jsonl events over a stale schedule projection",
    Effect.gen(function* () {
      const directory = yield* tempdir
      const sessionID = "ses_schedule_stale_projection" as SessionID
      const now = Date.now()

      yield* Effect.promise(() =>
        writeSessionStore({
          id: sessionID,
          slug: "schedule-stale-projection",
          version: "test",
          projectID: "proj_file",
          directory,
          path: ".",
          title: "Schedule stale projection",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: now, updated: now },
        } as any),
      )
      yield* Effect.promise(() =>
        writeSessionScheduleState(directory, sessionID, [
          {
            id: "sch_old_projection",
            sessionID,
            kind: "once",
            expression: "",
            runAt: now + 60_000,
            message: "old projection schedule",
            createdAt: now,
            lastRanAt: null,
            lastRunStatus: null,
            nextRun: now + 60_000,
          },
        ]),
      )
      yield* Effect.promise(() =>
        fs.appendFile(
          path.join(directory, ".agents", "atree", "sessions", sessionID, "session.jsonl"),
          `${JSON.stringify({
            version: 1,
            at: now + 10_000,
            type: "schedule.created",
            schedule: {
              id: "sch_new_jsonl",
              sessionID,
              kind: "once",
              expression: "",
              runAt: now + 120_000,
              message: "new jsonl schedule",
              createdAt: now + 10_000,
              lastRanAt: null,
              lastRunStatus: null,
              nextRun: now + 120_000,
            },
          })}\n`,
        ),
      )

      expect(yield* Effect.promise(() => readSessionScheduleState(directory, sessionID))).toMatchObject([
        { id: "sch_new_jsonl", message: "new jsonl schedule" },
      ])
    }),
  )

  it.effect(
    "prefers an explicit empty directory schedule state over stale database rows",
    Effect.gen(function* () {
      const directory = yield* tempdir
      const { db } = yield* Database.Service
      const sessionID = "ses_schedule_empty_projection" as SessionID
      const scheduleID = "sch_stale_empty_projection"
      const now = Date.now()

      yield* db
        .insert(ProjectTable)
        .values({
          id: "proj_empty_schedule_projection",
          worktree: directory,
          vcs: "git",
          name: "empty schedule projection",
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
          project_id: "proj_empty_schedule_projection",
          slug: "empty-schedule-projection",
          directory,
          title: "Empty schedule projection",
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
          slug: "empty-schedule-projection",
          version: "test",
          projectID: "proj_empty_schedule_projection",
          directory,
          path: ".",
          title: "Empty schedule projection",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: now, updated: now },
        } as any),
      )
      yield* Effect.promise(() => writeSessionScheduleState(directory, sessionID, []))
      yield* db
        .insert(ScheduleTable)
        .values({
          id: scheduleID as never,
          session_id: sessionID,
          kind: "once",
          expression: "",
          run_at: now + 60_000,
          message: "stale database schedule",
          created_at: now,
        })
        .run()
        .pipe(Effect.orDie)

      const schedules = yield* Schedule.Service.use((schedule) => schedule.list(sessionID))

      expect(schedules).toEqual([])
      const row = yield* db
        .select()
        .from(ScheduleTable)
        .where(eq(ScheduleTable.id, scheduleID as never))
        .get()
        .pipe(Effect.orDie)
      expect(row).toBeUndefined()
      expect(yield* Effect.promise(() => readSessionScheduleState(directory, sessionID))).toEqual([])
    }),
  )

  it.effect(
    "does not revive stale database schedules when a directory session has no schedule state",
    Effect.gen(function* () {
      const directory = yield* tempdir
      const { db } = yield* Database.Service
      const sessionID = "ses_schedule_missing_projection" as SessionID
      const scheduleID = "sch_stale_missing_projection"
      const now = Date.now()

      yield* db
        .insert(ProjectTable)
        .values({
          id: "proj_missing_schedule_projection",
          worktree: directory,
          vcs: "git",
          name: "missing schedule projection",
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
          project_id: "proj_missing_schedule_projection",
          slug: "missing-schedule-projection",
          directory,
          title: "Missing schedule projection",
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
          slug: "missing-schedule-projection",
          version: "test",
          projectID: "proj_missing_schedule_projection",
          directory,
          path: ".",
          title: "Missing schedule projection",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: now, updated: now },
        } as any),
      )
      yield* db
        .insert(ScheduleTable)
        .values({
          id: scheduleID as never,
          session_id: sessionID,
          kind: "once",
          expression: "",
          run_at: now + 60_000,
          message: "stale database schedule without directory state",
          created_at: now,
        })
        .run()
        .pipe(Effect.orDie)

      const schedules = yield* Schedule.Service.use((schedule) => schedule.list(sessionID))

      expect(schedules).toEqual([])
      const row = yield* db
        .select()
        .from(ScheduleTable)
        .where(eq(ScheduleTable.id, scheduleID as never))
        .get()
        .pipe(Effect.orDie)
      expect(row).toBeUndefined()
    }),
  )

  it.effect(
    "ignores stale database schedules when creating for a directory session with no schedule state",
    Effect.gen(function* () {
      const directory = yield* tempdir
      const { db } = yield* Database.Service
      const sessionID = "ses_schedule_create_missing_projection" as SessionID
      const staleScheduleID = "sch_stale_create_missing_projection"
      const now = Date.now()

      yield* db
        .insert(ProjectTable)
        .values({
          id: "proj_create_missing_schedule_projection",
          worktree: directory,
          vcs: "git",
          name: "create missing schedule projection",
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
          project_id: "proj_create_missing_schedule_projection",
          slug: "create-missing-schedule-projection",
          directory,
          title: "Create missing schedule projection",
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
          slug: "create-missing-schedule-projection",
          version: "test",
          projectID: "proj_create_missing_schedule_projection",
          directory,
          path: ".",
          title: "Create missing schedule projection",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: now, updated: now },
        } as any),
      )
      yield* db
        .insert(ScheduleTable)
        .values({
          id: staleScheduleID as never,
          session_id: sessionID,
          kind: "once",
          expression: "",
          run_at: now + 60_000,
          message: "stale schedule should not block create",
          created_at: now,
        })
        .run()
        .pipe(Effect.orDie)

      const created = yield* Schedule.Service.use((schedule) =>
        schedule.create({
          sessionID,
          directory,
          kind: "once",
          runAt: now + 120_000,
          message: "created after stale cache",
        }),
      )

      expect(created.message).toBe("created after stale cache")
      const row = yield* db
        .select()
        .from(ScheduleTable)
        .where(eq(ScheduleTable.id, staleScheduleID as never))
        .get()
        .pipe(Effect.orDie)
      expect(row).toBeUndefined()
      expect(yield* Effect.promise(() => readSessionScheduleState(directory, sessionID))).toEqual([
        expect.objectContaining({ id: created.id, message: "created after stale cache" }),
      ])
    }),
  )

  it.effect(
    "prefers directory schedule details over stale database rows with the same id",
    Effect.gen(function* () {
      const directory = yield* tempdir
      const { db } = yield* Database.Service
      const sessionID = "ses_schedule_same_id_projection" as SessionID
      const scheduleID = "sch_same_id_projection"
      const now = Date.now()

      yield* db
        .insert(ProjectTable)
        .values({
          id: "proj_same_id_schedule_projection",
          worktree: directory,
          vcs: "git",
          name: "same id schedule projection",
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
          project_id: "proj_same_id_schedule_projection",
          slug: "same-id-schedule-projection",
          directory,
          title: "Same id schedule projection",
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
          slug: "same-id-schedule-projection",
          version: "test",
          projectID: "proj_same_id_schedule_projection",
          directory,
          path: ".",
          title: "Same id schedule projection",
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
            message: "directory schedule",
            createdAt: now + 1,
            lastRanAt: null,
            lastRunStatus: null,
            nextRun: now + 120_000,
          },
        ]),
      )
      yield* db
        .insert(ScheduleTable)
        .values({
          id: scheduleID as never,
          session_id: sessionID,
          kind: "once",
          expression: "",
          run_at: now + 60_000,
          message: "stale database schedule",
          created_at: now,
        })
        .run()
        .pipe(Effect.orDie)

      const schedules = yield* Schedule.Service.use((schedule) => schedule.list(sessionID))

      expect(schedules).toHaveLength(1)
      expect(schedules[0]).toMatchObject({
        id: scheduleID,
        message: "directory schedule",
        runAt: now + 120_000,
      })
      const row = yield* db
        .select()
        .from(ScheduleTable)
        .where(eq(ScheduleTable.id, scheduleID as never))
        .get()
        .pipe(Effect.orDie)
      expect(row?.message).toBe("directory schedule")
      expect(row?.run_at).toBe(now + 120_000)
    }),
  )

  it.effect(
    "ignores a stale database directory when creating schedule state from the persisted atree root",
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const data = yield* Effect.acquireRelease(
        Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "atree-schedule-stale-data-"))),
        (dir) => Effect.promise(() => fs.rm(dir, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "atree-schedule-stale-root-"))),
        (dir) => Effect.promise(() => fs.rm(dir, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      const previousData = Global.Path.data
      ;(Global.Path as { data: string }).data = data
      yield* Effect.addFinalizer(() => Effect.sync(() => ((Global.Path as { data: string }).data = previousData)))

      const staleDirectory = path.join(root, "old")
      const actualDirectory = path.join(root, "new")
      const sessionID = "ses_stale_schedule_directory" as SessionID
      const now = Date.now()
      yield* Effect.promise(() => fs.mkdir(staleDirectory, { recursive: true }))
      yield* Effect.promise(() => fs.mkdir(actualDirectory, { recursive: true }))
      yield* Effect.promise(() => writeWorkspaceRoot(root))
      yield* db
        .insert(ProjectTable)
        .values({
          id: "proj_stale_schedule",
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
          project_id: "proj_stale_schedule",
          slug: "stale-schedule-directory",
          directory: staleDirectory,
          title: "Stale schedule directory",
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
          slug: "actual-schedule-directory",
          version: "test",
          projectID: "proj_actual_schedule",
          directory: actualDirectory,
          path: "new",
          title: "Actual schedule directory",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: now, updated: now },
        } as any),
      )

      const created = yield* Schedule.Service.use((schedule) =>
        schedule.create({
          sessionID,
          kind: "once",
          runAt: now + 60_000,
          message: "created in actual schedule directory",
        }),
      )

      expect(created).toMatchObject({ sessionID, message: "created in actual schedule directory" })
      expect(yield* Effect.promise(() => readSessionScheduleState(actualDirectory, sessionID))).toHaveLength(1)
      expect(yield* Effect.promise(() => readSessionScheduleState(staleDirectory, sessionID))).toEqual([])
    }),
  )

  it.effect(
    "prefers empty schedule state from the persisted root over stale database rows",
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const data = yield* Effect.acquireRelease(
        Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "atree-schedule-empty-root-data-"))),
        (dir) => Effect.promise(() => fs.rm(dir, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "atree-schedule-empty-root-"))),
        (dir) => Effect.promise(() => fs.rm(dir, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      const previousData = Global.Path.data
      ;(Global.Path as { data: string }).data = data
      yield* Effect.addFinalizer(() => Effect.sync(() => ((Global.Path as { data: string }).data = previousData)))

      const staleDirectory = path.join(root, "old")
      const actualDirectory = path.join(root, "new")
      const sessionID = "ses_empty_root_schedule" as SessionID
      const scheduleID = "sch_empty_root_schedule"
      const now = Date.now()
      yield* Effect.promise(() => fs.mkdir(staleDirectory, { recursive: true }))
      yield* Effect.promise(() => fs.mkdir(actualDirectory, { recursive: true }))
      yield* Effect.promise(() => writeWorkspaceRoot(root))
      yield* db
        .insert(ProjectTable)
        .values({
          id: "proj_empty_root_schedule",
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
          project_id: "proj_empty_root_schedule",
          slug: "empty-root-schedule",
          directory: staleDirectory,
          title: "Empty root schedule",
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
        .insert(ScheduleTable)
        .values({
          id: scheduleID as never,
          session_id: sessionID,
          kind: "once",
          expression: "",
          run_at: now + 60_000,
          message: "stale database schedule",
          created_at: now,
        })
        .run()
        .pipe(Effect.orDie)
      yield* Effect.promise(() =>
        writeSessionStore({
          id: sessionID,
          slug: "actual-empty-root-schedule",
          version: "test",
          projectID: "proj_actual_empty_root_schedule",
          directory: actualDirectory,
          path: "new",
          title: "Actual empty root schedule",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: now, updated: now },
        } as any),
      )
      yield* Effect.promise(() => writeSessionScheduleState(actualDirectory, sessionID, []))

      const schedules = yield* Schedule.Service.use((schedule) => schedule.list(sessionID))

      expect(schedules).toEqual([])
      const row = yield* db
        .select()
        .from(ScheduleTable)
        .where(eq(ScheduleTable.id, scheduleID as never))
        .get()
        .pipe(Effect.orDie)
      expect(row).toBeUndefined()
      expect(yield* Effect.promise(() => readSessionScheduleState(actualDirectory, sessionID))).toEqual([])
      expect(yield* Effect.promise(() => readSessionScheduleState(staleDirectory, sessionID))).toEqual([])
    }),
  )

  it.instance(
    "creates a schedule for a nested file-backed session found from the persisted atree root",
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const data = yield* tempdir
      const previousData = Global.Path.data
      ;(Global.Path as { data: string }).data = data
      yield* Effect.addFinalizer(() => Effect.sync(() => ((Global.Path as { data: string }).data = previousData)))

      const sessionID = "ses_nested_create_schedule" as SessionID
      const now = Date.now()
      const nodeDirectory = path.join(instance.directory, "nested", "schedule-node")
      yield* Effect.promise(() => fs.mkdir(nodeDirectory, { recursive: true }))
      yield* Effect.promise(() => writeWorkspaceRoot(instance.directory))
      yield* Effect.promise(() =>
        writeSessionStore({
          id: sessionID,
          slug: "nested-create-schedule",
          version: "test",
          projectID: "proj_file",
          directory: nodeDirectory,
          path: "nested/schedule-node",
          title: "Nested create schedule",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: now, updated: now },
        } as any),
      )

      const created = yield* Schedule.Service.use((schedule) =>
        schedule.create({
          sessionID,
          kind: "once",
          runAt: now + 60_000,
          message: "created from nested file-backed session",
        }),
      )

      expect(created).toMatchObject({ sessionID, message: "created from nested file-backed session" })
      const stored = yield* Effect.promise(() => readSessionScheduleState(nodeDirectory, sessionID))
      expect(stored).toHaveLength(1)
      expect(stored[0]).toMatchObject({ id: created.id, message: "created from nested file-backed session" })
    }),
  )

  it.instance(
    "rejects a second schedule when a file-backed session already has directory schedule state",
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const sessionID = "ses_file_duplicate_schedule" as SessionID
      const now = Date.now()

      yield* Effect.promise(() =>
        writeSessionStore({
          id: sessionID,
          slug: "file-duplicate-schedule",
          version: "test",
          projectID: "proj_file",
          directory: instance.directory,
          path: ".",
          title: "File duplicate schedule",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: now, updated: now },
        } as any),
      )
      yield* Effect.promise(() =>
        writeSessionScheduleState(instance.directory, sessionID, [
          {
            id: "sch_duplicate_file",
            sessionID,
            kind: "once",
            expression: "",
            runAt: now + 60_000,
            message: "existing file-backed schedule",
            createdAt: now,
            lastRanAt: null,
            lastRunStatus: null,
            nextRun: now + 60_000,
          },
        ]),
      )

      const error = yield* Schedule.Service.use((schedule) =>
        schedule
          .create({
            sessionID,
            kind: "once",
            runAt: now + 120_000,
            message: "second file-backed schedule",
          })
          .pipe(Effect.flip),
      )

      expect(error._tag).toBe("ScheduleLimitExceeded")
      expect(yield* Effect.promise(() => readSessionScheduleState(instance.directory, sessionID))).toHaveLength(1)
    }),
  )

  it.instance(
    "clears stale directory schedule state without a DB schedule row",
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const sessionID = "ses_file_stale_schedule" as SessionID
      const now = Date.now()

      yield* Effect.promise(() =>
        writeSessionStore({
          id: sessionID,
          slug: "file-stale-schedule",
          version: "test",
          projectID: "proj_file",
          directory: instance.directory,
          path: ".",
          title: "File stale schedule",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: now, updated: now },
        } as any),
      )
      yield* Effect.promise(() =>
        writeSessionScheduleState(instance.directory, sessionID, [
          {
            id: "sch_stale",
            sessionID,
            kind: "once",
            expression: "",
            runAt: now + 60_000,
            message: "stale schedule",
            createdAt: now,
            lastRanAt: null,
            lastRunStatus: null,
            nextRun: now + 60_000,
          },
        ]),
      )

      yield* Schedule.Service.use((schedule) => schedule.clear(sessionID))
      expect(yield* Effect.promise(() => readSessionScheduleState(instance.directory, sessionID))).toEqual([])
      const raw = yield* Effect.promise(() =>
        fs.readFile(path.join(instance.directory, ".agents", "atree", "sessions", sessionID, "session.jsonl"), "utf8"),
      )
      const entries = raw
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>)
      expect(entries).toContainEqual(
        expect.objectContaining({
          type: "schedule.deleted",
          scheduleID: "sch_stale",
          sessionID,
          reason: "cleared",
        }),
      )
    }),
  )

  it.effect(
    "clears schedules for an explicit directory without a database session row",
    Effect.gen(function* () {
      const directory = yield* tempdir
      const sessionID = "ses_explicit_clear_schedule" as SessionID
      const now = Date.now()

      yield* Effect.promise(() =>
        writeSessionStore({
          id: sessionID,
          slug: "explicit-clear-schedule",
          version: "test",
          projectID: "proj_file",
          directory,
          path: ".",
          title: "Explicit clear schedule",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: now, updated: now },
        } as any),
      )
      yield* Effect.promise(() =>
        writeSessionScheduleState(directory, sessionID, [
          {
            id: "sch_explicit_clear",
            sessionID,
            kind: "once",
            expression: "",
            runAt: now + 60_000,
            message: "clear with explicit directory",
            createdAt: now,
            lastRanAt: null,
            lastRunStatus: null,
            nextRun: now + 60_000,
          },
        ]),
      )

      yield* Schedule.Service.use((schedule) => schedule.clear(sessionID, { directory }))
      expect(yield* Effect.promise(() => readSessionScheduleState(directory, sessionID))).toEqual([])
      const raw = yield* Effect.promise(() =>
        fs.readFile(path.join(directory, ".agents", "atree", "sessions", sessionID, "session.jsonl"), "utf8"),
      )
      const entries = raw
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>)
      expect(entries).toContainEqual(
        expect.objectContaining({
          type: "schedule.deleted",
          scheduleID: "sch_explicit_clear",
          sessionID,
          reason: "cleared",
        }),
      )
    }),
  )

  it.instance(
    "does not restore stale schedule state for an archived file-backed session",
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const sessionID = "ses_file_archived_schedule" as SessionID
      const now = Date.now()

      yield* Effect.promise(() =>
        writeSessionStore({
          id: sessionID,
          slug: "file-archived-schedule",
          version: "test",
          projectID: "proj_file",
          directory: instance.directory,
          path: ".",
          title: "File archived schedule",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: now, updated: now, archived: now },
        } as any),
      )
      yield* Effect.promise(() =>
        writeSessionScheduleState(instance.directory, sessionID, [
          {
            id: "sch_archived_stale",
            sessionID,
            kind: "once",
            expression: "",
            runAt: now + 60_000,
            message: "should not restore",
            createdAt: now,
            lastRanAt: null,
            lastRunStatus: null,
            nextRun: now + 60_000,
          },
        ]),
      )

      const schedules = yield* Schedule.Service.use((schedule) => schedule.list(sessionID))
      expect(schedules).toEqual([])
      expect(yield* Effect.promise(() => readSessionScheduleState(instance.directory, sessionID))).toEqual([])
      const raw = yield* Effect.promise(() =>
        fs.readFile(path.join(instance.directory, ".agents", "atree", "sessions", sessionID, "session.jsonl"), "utf8"),
      )
      const entries = raw
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>)
      expect(entries).toContainEqual(
        expect.objectContaining({
          type: "schedule.deleted",
          scheduleID: "sch_archived_stale",
          sessionID,
          reason: "archived",
        }),
      )
    }),
  )

  it.instance(
    "prefers archived file metadata over stale database cache when restoring schedules",
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const ctx = yield* InstanceState.context
      const { db } = yield* Database.Service
      const sessionID = "ses_file_archived_over_cache" as SessionID
      const now = Date.now()

      yield* Effect.promise(() =>
        writeSessionStore({
          id: sessionID,
          slug: "file-archived-over-cache",
          version: "test",
          projectID: ctx.project.id,
          directory: instance.directory,
          path: ".",
          title: "File archive wins",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: now, updated: now, archived: now },
        } as any),
      )
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: ctx.project.id,
          slug: "stale-active-cache",
          directory: instance.directory,
          path: ".",
          title: "Stale active cache",
          version: "test",
          cost: 0,
          tokens_input: 0,
          tokens_output: 0,
          tokens_reasoning: 0,
          tokens_cache_read: 0,
          tokens_cache_write: 0,
          time_created: now,
          time_updated: now,
          time_archived: null,
        } as typeof SessionTable.$inferInsert)
        .run()
        .pipe(Effect.orDie)
      yield* Effect.promise(() =>
        writeSessionScheduleState(instance.directory, sessionID, [
          {
            id: "sch_stale_cache",
            sessionID,
            kind: "once",
            expression: "",
            runAt: now + 60_000,
            message: "should be cleared by file archive",
            createdAt: now,
            lastRanAt: null,
            lastRunStatus: null,
            nextRun: now + 60_000,
          },
        ]),
      )

      const schedules = yield* Schedule.Service.use((schedule) => schedule.list(sessionID))
      expect(schedules).toEqual([])
      expect(yield* Effect.promise(() => readSessionScheduleState(instance.directory, sessionID))).toEqual([])
      const raw = yield* Effect.promise(() =>
        fs.readFile(path.join(instance.directory, ".agents", "atree", "sessions", sessionID, "session.jsonl"), "utf8"),
      )
      const entries = raw
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>)
      expect(entries).toContainEqual(
        expect.objectContaining({
          type: "schedule.deleted",
          scheduleID: "sch_stale_cache",
          sessionID,
          reason: "archived",
        }),
      )

      const row = yield* db
        .select({ title: SessionTable.title, archived: SessionTable.time_archived })
        .from(SessionTable)
        .where(eq(SessionTable.id, sessionID))
        .get()
        .pipe(Effect.orDie)
      expect(row?.title).toBe("File archive wins")
      expect(row?.archived).toBe(now)
    }),
  )
})
