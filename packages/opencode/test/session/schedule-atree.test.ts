import { describe, expect } from "bun:test"
import { randomUUID } from "crypto"
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
import { ScheduleRunTable, ScheduleTable } from "../../src/session/schedule.sql"
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

      const schedules = yield* Schedule.Service.use((schedule) => schedule.list(sessionID, { directory }))
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

  baseIt.effect(
    "removes stale database schedules at startup when no file-backed session exists",
    Effect.gen(function* () {
      const directory = yield* tempdir
      const { db } = yield* Database.Service
      const sessionID = "ses_missing_schedule_boot" as SessionID
      const scheduleID = "sch_missing_schedule_boot"
      const now = Date.now()

      yield* db
        .insert(ProjectTable)
        .values({
          id: "proj_missing_schedule_boot",
          worktree: directory,
          vcs: "git",
          name: "missing schedule boot",
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
          project_id: "proj_missing_schedule_boot",
          slug: "missing-schedule-boot",
          directory,
          title: "Missing schedule boot",
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
          message: "stale startup schedule",
          created_at: now,
        })
        .run()
        .pipe(Effect.orDie)

      yield* Effect.gen(function* () {
        yield* Schedule.Service
      }).pipe(Effect.provide(schedule))

      const row = yield* db
        .select()
        .from(ScheduleTable)
        .where(eq(ScheduleTable.id, scheduleID as never))
        .get()
        .pipe(Effect.orDie)
      expect(row).toBeUndefined()
    }),
  )

  baseIt.effect(
    "ignores stale database run history when restoring a once schedule from directory state",
    Effect.gen(function* () {
      const directory = yield* tempdir
      const { db } = yield* Database.Service
      const sessionID = "ses_once_schedule_stale_run" as SessionID
      const scheduleID = "sch_once_schedule_stale_run"
      const now = Date.now()

      yield* Effect.promise(() =>
        writeWorkspaceRoot(directory),
      )
      yield* Effect.promise(() =>
        writeSessionStore({
          id: sessionID,
          slug: "once-schedule-stale-run",
          version: "test",
          projectID: "proj_once_schedule_stale_run",
          directory,
          path: ".",
          title: "Once schedule stale run",
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
            message: "directory is authoritative",
            createdAt: now,
            lastRanAt: null,
            lastRunStatus: null,
            nextRun: now + 60_000,
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
          message: "stale db once schedule",
          created_at: now,
        })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(ScheduleRunTable)
        .values({
          id: randomUUID(),
          schedule_id: scheduleID,
          ran_at: now - 30_000,
          status: "ran",
        })
        .run()
        .pipe(Effect.orDie)

      yield* Effect.gen(function* () {
        yield* Schedule.Service
      }).pipe(Effect.provide(schedule))

      const schedules = yield* Schedule.Service.use((service) => service.list(sessionID, { directory })).pipe(Effect.provide(schedule))
      expect(schedules).toHaveLength(1)
      expect(schedules[0]).toMatchObject({
        id: scheduleID,
        kind: "once",
        lastRanAt: null,
        lastRunStatus: null,
        message: "directory is authoritative",
      })
      expect(yield* Effect.promise(() => readSessionScheduleState(directory, sessionID))).toEqual([
        expect.objectContaining({
          id: scheduleID,
          lastRanAt: null,
          lastRunStatus: null,
          message: "directory is authoritative",
        }),
      ])
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

      const schedules = yield* Schedule.Service.use((schedule) =>
        schedule.list(sessionID, { directory: instance.directory }),
      )
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

  it.effect(
    "lists nested file-backed schedules from an explicit root directory hint",
    Effect.gen(function* () {
      const root = yield* tempdir
      const nodeDirectory = path.join(root, "projects", "ops")
      const sessionID = "ses_nested_explicit_root_schedule" as SessionID
      const now = Date.now()

      yield* Effect.promise(() => fs.mkdir(nodeDirectory, { recursive: true }))
      yield* Effect.promise(() =>
        writeSessionStore({
          id: sessionID,
          slug: "nested-explicit-root-schedule",
          version: "test",
          projectID: "proj_file",
          directory: nodeDirectory,
          path: "projects/ops",
          title: "Nested explicit root schedule",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: now, updated: now },
        } as any),
      )
      yield* Effect.promise(() =>
        writeSessionScheduleState(nodeDirectory, sessionID, [
          {
            id: "sch_nested_explicit_root",
            sessionID,
            kind: "once",
            expression: "",
            runAt: now + 60_000,
            message: "list from explicit root",
            createdAt: now,
            lastRanAt: null,
            lastRunStatus: null,
            nextRun: now + 60_000,
          },
        ]),
      )

      const listed = yield* Schedule.Service.use((schedule) => schedule.list(sessionID, { directory: root }))

      expect(listed).toHaveLength(1)
      expect(listed[0]).toMatchObject({
        id: "sch_nested_explicit_root",
        sessionID,
        message: "list from explicit root",
      })
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
    "does not let another directory's projected schedule block create for the current directory",
    Effect.gen(function* () {
      const root = yield* tempdir
      const source = path.join(root, "source")
      const target = path.join(root, "target")
      const { db } = yield* Database.Service
      const sessionID = "ses_cross_directory_schedule_limit" as SessionID
      const sourceScheduleID = "sch_cross_directory_source"
      const now = Date.now()

      yield* Effect.promise(() => fs.mkdir(source, { recursive: true }))
      yield* Effect.promise(() => fs.mkdir(target, { recursive: true }))
      yield* Effect.promise(() =>
        writeSessionStore({
          id: sessionID,
          slug: "cross-directory-source",
          version: "test",
          projectID: "proj_cross_directory_source",
          directory: source,
          path: ".",
          title: "Cross directory source",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: now, updated: now },
        } as any),
      )
      yield* Effect.promise(() =>
        writeSessionStore({
          id: sessionID,
          slug: "cross-directory-target",
          version: "test",
          projectID: "proj_cross_directory_target",
          directory: target,
          path: ".",
          title: "Cross directory target",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: now, updated: now },
        } as any),
      )
      yield* Effect.promise(() =>
        writeSessionScheduleState(source, sessionID, [
          {
            id: sourceScheduleID,
            sessionID,
            kind: "once",
            expression: "",
            runAt: now + 60_000,
            message: "source directory schedule",
            createdAt: now,
            lastRanAt: null,
            lastRunStatus: null,
            nextRun: now + 60_000,
          },
        ]),
      )
      yield* db
        .insert(ProjectTable)
        .values({
          id: "proj_cross_directory_source",
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
        .insert(ProjectTable)
        .values({
          id: "proj_cross_directory_target",
          worktree: target,
          vcs: null,
          name: null,
          time_created: now,
          time_updated: now,
          sandboxes: [],
        } as unknown as typeof ProjectTable.$inferInsert)
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(ScheduleTable)
        .values({
          id: sourceScheduleID as never,
          session_id: sessionID,
          kind: "once",
          expression: "",
          run_at: now + 60_000,
          message: "source projected schedule",
          created_at: now,
        })
        .run()
        .pipe(Effect.orDie)

      const created = yield* Schedule.Service.use((schedule) =>
        schedule.create({
          sessionID,
          directory: target,
          kind: "once",
          runAt: now + 120_000,
          message: "target directory schedule",
        }),
      )

      expect(created.message).toBe("target directory schedule")
      expect(yield* Effect.promise(() => readSessionScheduleState(target, sessionID))).toEqual([
        expect.objectContaining({ id: created.id, message: "target directory schedule" }),
      ])
      expect(yield* Effect.promise(() => readSessionScheduleState(source, sessionID))).toEqual([
        expect.objectContaining({ id: sourceScheduleID, message: "source directory schedule" }),
      ])
    }),
  )

  it.effect(
    "does not revive persisted-root schedules when the session store was removed",
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const data = yield* Effect.acquireRelease(
        Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "atree-schedule-root-missing-data-"))),
        (dir) => Effect.promise(() => fs.rm(dir, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      const root = yield* tempdir
      const previousData = Global.Path.data
      ;(Global.Path as { data: string }).data = data
      yield* Effect.addFinalizer(() => Effect.sync(() => ((Global.Path as { data: string }).data = previousData)))

      const node = path.join(root, "node")
      const suffix = randomUUID().replaceAll("-", "")
      const projectID = `proj_schedule_root_missing_${suffix}`
      const sessionID = `ses_schedule_root_missing_${suffix}` as SessionID
      const scheduleID = `sch_schedule_root_missing_${suffix}` as Schedule.ID
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
          slug: "schedule-root-missing",
          directory: node,
          title: "Schedule root missing",
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
          message: "stale persisted-root schedule",
          created_at: now,
        })
        .run()
        .pipe(Effect.orDie)
      yield* Effect.promise(() =>
        writeSessionStore({
          id: sessionID,
          slug: "schedule-root-missing",
          version: "test",
          projectID,
          directory: node,
          path: "node",
          title: "Schedule root missing",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: now, updated: now },
        } as any),
      )
      yield* Effect.promise(() =>
        fs.rm(path.join(node, ".agents", "atree", "sessions", sessionID), { recursive: true, force: true }),
      )

      const events = yield* EventV2Bridge.Service
      const triggered: unknown[] = []
      const unsubscribe = yield* events.listen((event) =>
        Effect.sync(() => {
          if (event.type === "schedule.triggered") triggered.push(event)
        }),
      )
      yield* Effect.addFinalizer(() => unsubscribe)

      const listed = yield* Schedule.Service.use((schedule) => schedule.list(sessionID))
      expect(listed).toEqual([])
      yield* Schedule.Service.use((schedule) => schedule.tick(scheduleID))
      expect(triggered).toEqual([])

      const created = yield* Schedule.Service.use((schedule) =>
        schedule
          .create({
            sessionID,
            kind: "once",
            runAt: now + 60_000,
            message: "should not be created",
          })
          .pipe(Effect.exit),
      )
      expect(Exit.isFailure(created)).toBe(true)
    }),
  )

  it.instance("does not revive unscoped database schedules when the session store was removed", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const instance = yield* TestInstance
      const suffix = randomUUID().replaceAll("-", "")
      const projectID = `proj_schedule_unscoped_missing_${suffix}`
      const sessionID = `ses_schedule_unscoped_missing_${suffix}` as SessionID
      const scheduleID = `sch_schedule_unscoped_missing_${suffix}` as Schedule.ID
      const now = Date.now()

      yield* db
        .insert(ProjectTable)
        .values({
          id: projectID,
          worktree: instance.directory,
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
          slug: "schedule-unscoped-missing",
          directory: instance.directory,
          title: "Schedule unscoped missing",
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
          message: "stale unscoped database schedule",
          created_at: now,
        })
        .run()
        .pipe(Effect.orDie)
      yield* Effect.promise(() =>
        writeSessionStore({
          id: sessionID,
          slug: "schedule-unscoped-missing",
          version: "test",
          projectID,
          directory: instance.directory,
          title: "Schedule unscoped missing",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: now, updated: now },
        } as any),
      )
      yield* Effect.promise(() =>
        fs.rm(path.join(instance.directory, ".agents", "atree", "sessions", sessionID), {
          recursive: true,
          force: true,
        }),
      )

      const events = yield* EventV2Bridge.Service
      const triggered: unknown[] = []
      const unsubscribe = yield* events.listen((event) =>
        Effect.sync(() => {
          if (event.type === "schedule.triggered") triggered.push(event)
        }),
      )
      yield* Effect.addFinalizer(() => unsubscribe)

      const listed = yield* Schedule.Service.use((schedule) => schedule.list(sessionID))
      expect(listed).toEqual([])
      yield* Schedule.Service.use((schedule) => schedule.tick(scheduleID))
      expect(triggered).toEqual([])

      const created = yield* Schedule.Service.use((schedule) =>
        schedule
          .create({
            sessionID,
            kind: "once",
            runAt: now + 60_000,
            message: "should not be created",
          })
          .pipe(Effect.exit),
      )
      expect(Exit.isFailure(created)).toBe(true)
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

  it.effect(
    "prefers deleting directory schedule state over a stale database row with the same id",
    Effect.gen(function* () {
      const data = yield* Effect.acquireRelease(
        Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "atree-schedule-delete-stale-data-"))),
        (dir) => Effect.promise(() => fs.rm(dir, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      const root = yield* tempdir
      const previousData = Global.Path.data
      ;(Global.Path as { data: string }).data = data
      yield* Effect.addFinalizer(() => Effect.sync(() => ((Global.Path as { data: string }).data = previousData)))

      const { db } = yield* Database.Service
      const staleDirectory = path.join(root, "stale")
      const actualDirectory = path.join(root, "actual")
      const staleSessionID = "ses_stale_delete_schedule" as SessionID
      const actualSessionID = "ses_actual_delete_schedule" as SessionID
      const scheduleID = "sch_delete_prefers_directory"
      const now = Date.now()

      yield* Effect.promise(() => fs.mkdir(staleDirectory, { recursive: true }))
      yield* Effect.promise(() => fs.mkdir(actualDirectory, { recursive: true }))
      yield* Effect.promise(() => writeWorkspaceRoot(root))
      yield* db
        .insert(ProjectTable)
        .values({
          id: "proj_stale_delete_schedule",
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
          id: staleSessionID,
          project_id: "proj_stale_delete_schedule",
          slug: "stale-delete-schedule",
          directory: staleDirectory,
          title: "Stale delete schedule",
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
          session_id: staleSessionID,
          kind: "once",
          expression: "",
          run_at: now + 30_000,
          message: "stale database schedule",
          created_at: now,
        })
        .run()
        .pipe(Effect.orDie)
      yield* Effect.promise(() =>
        writeSessionStore({
          id: actualSessionID,
          slug: "actual-delete-schedule",
          version: "test",
          projectID: "proj_actual_delete_schedule",
          directory: actualDirectory,
          path: "actual",
          title: "Actual delete schedule",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: now, updated: now },
        } as any),
      )
      yield* Effect.promise(() =>
        writeSessionScheduleState(actualDirectory, actualSessionID, [
          {
            id: scheduleID,
            sessionID: actualSessionID,
            kind: "once",
            expression: "",
            runAt: now + 60_000,
            message: "actual directory schedule",
            createdAt: now,
            lastRanAt: null,
            lastRunStatus: null,
            nextRun: now + 60_000,
          },
        ]),
      )

      yield* Schedule.Service.use((schedule) => schedule.delete(scheduleID as never))

      expect(yield* Effect.promise(() => readSessionScheduleState(actualDirectory, actualSessionID))).toEqual([])
      const row = yield* db
        .select()
        .from(ScheduleTable)
        .where(eq(ScheduleTable.id, scheduleID as never))
        .get()
        .pipe(Effect.orDie)
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
      expect(yield* schedules.list(sessionID, { directory: source.directory })).toHaveLength(1)
      const beforeClear = yield* db
        .select()
        .from(ScheduleTable)
        .where(eq(ScheduleTable.id, storedSchedule.id as never))
        .get()
        .pipe(Effect.orDie)
      expect(beforeClear?.message).toBe("copied schedule")
      yield* Effect.promise(() =>
        fs.cp(path.join(source.directory, ".agents"), path.join(target, ".agents"), { recursive: true }),
      )

      yield* schedules.clear(sessionID, { directory: target })

      expect(yield* Effect.promise(() => readSessionScheduleState(target, sessionID))).toEqual([])
      expect(yield* Effect.promise(() => readSessionScheduleState(source.directory, sessionID))).toEqual([
        storedSchedule,
      ])
      const afterClear = yield* db
        .select()
        .from(ScheduleTable)
        .where(eq(ScheduleTable.id, storedSchedule.id as never))
        .get()
        .pipe(Effect.orDie)
      expect(afterClear?.message).toBe("copied schedule")
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
      expect(yield* schedules.list(sessionID, { directory: source.directory })).toHaveLength(1)
      const sourceBeforeDelete = yield* Effect.promise(() => readSessionScheduleState(source.directory, sessionID))
      yield* Effect.promise(() =>
        fs.cp(path.join(source.directory, ".agents"), path.join(target, ".agents"), { recursive: true }),
      )

      const events = yield* EventV2Bridge.Service
      const eventDirectories: string[] = []
      const off = yield* events.listen((event) => {
        if (event.type === Schedule.Event.Deleted.type) eventDirectories.push(event.location?.directory ?? "")
        return Effect.void
      })
      yield* Effect.addFinalizer(() => off)

      yield* schedules.delete(storedSchedule.id as Schedule.ID, { directory: target })

      expect(yield* Effect.promise(() => readSessionScheduleState(target, sessionID))).toEqual([])
      expect(yield* Effect.promise(() => readSessionScheduleState(source.directory, sessionID))).toEqual(sourceBeforeDelete)
      expect(eventDirectories).toEqual([target])
      const row = yield* db
        .select()
        .from(ScheduleTable)
        .where(eq(ScheduleTable.id, storedSchedule.id as never))
        .get()
        .pipe(Effect.orDie)
      expect(row?.message).toBe("delete copied schedule")
    }),
  )

  it.instance(
    "clears copied file-backed schedule state in the explicit target directory without deleting the source DB row when no timer is running",
    Effect.gen(function* () {
      const schedules = yield* Schedule.Service
      const source = yield* TestInstance
      const target = yield* Effect.acquireRelease(
        Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "atree-schedule-clear-target-no-timer-"))),
        (dir) => Effect.promise(() => fs.rm(dir, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      const data = yield* Effect.acquireRelease(
        Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "atree-schedule-clear-target-no-timer-data-"))),
        (dir) => Effect.promise(() => fs.rm(dir, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      const previousData = Global.Path.data
      ;(Global.Path as { data: string }).data = data
      yield* Effect.addFinalizer(() => Effect.sync(() => ((Global.Path as { data: string }).data = previousData)))
      yield* Effect.promise(() => writeWorkspaceRoot(path.dirname(source.directory)))

      const { db } = yield* Database.Service
      const sessionID = "ses_copied_schedule_clear_no_timer" as SessionID
      const scheduleID = "sch_copied_schedule_clear_no_timer"
      const now = Date.now()
      const storedSchedule = {
        id: scheduleID,
        sessionID,
        kind: "once" as const,
        expression: "",
        runAt: now + 60_000,
        message: "source clear without timer",
        createdAt: now,
        lastRanAt: null,
        lastRunStatus: null,
        nextRun: now + 60_000,
      }

      yield* db
        .insert(ProjectTable)
        .values({
          id: "proj_copied_schedule_clear_no_timer",
          worktree: source.directory,
          vcs: "git",
          name: "copied schedule clear no timer",
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
          project_id: "proj_copied_schedule_clear_no_timer",
          slug: "copied-schedule-clear-no-timer",
          directory: source.directory,
          title: "Copied schedule clear no timer",
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
          message: "source clear without timer",
          created_at: now,
        })
        .run()
        .pipe(Effect.orDie)
      yield* Effect.promise(() =>
        writeSessionStore({
          id: sessionID,
          slug: "copied-schedule-clear-no-timer",
          version: "test",
          projectID: "proj_copied_schedule_clear_no_timer",
          directory: source.directory,
          path: ".",
          title: "Copied schedule clear no timer",
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
      const row = yield* db
        .select()
        .from(ScheduleTable)
        .where(eq(ScheduleTable.id, scheduleID as never))
        .get()
        .pipe(Effect.orDie)
      expect(row?.message).toBe("source clear without timer")
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

      const schedules = yield* Schedule.Service.use((schedule) =>
        schedule.list(sessionID, { directory: instance.directory }),
      )
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

  it.effect(
    "records a run for a file-backed schedule without a database schedule row",
    Effect.gen(function* () {
      const directory = yield* tempdir
      const sessionID = "ses_file_record_run_schedule" as SessionID
      const scheduleID = "sch_file_record_run"
      const now = Date.now()
      const ranAt = now + 1_000

      yield* Effect.promise(() =>
        writeSessionStore({
          id: sessionID,
          slug: "file-record-run-schedule",
          version: "test",
          projectID: "proj_file",
          directory,
          path: ".",
          title: "File record run schedule",
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
            kind: "recurring",
            expression: "* * * * *",
            runAt: null,
            message: "record file-backed run",
            createdAt: now,
            lastRanAt: null,
            lastRunStatus: null,
            nextRun: now + 60_000,
          },
        ]),
      )

      yield* Schedule.Service.use((schedule) =>
        schedule.recordRun(scheduleID as Schedule.ID, sessionID, "ran", ranAt, { directory }),
      )

      const state = yield* Effect.promise(() => readSessionScheduleState(directory, sessionID))
      expect(state).toHaveLength(1)
      expect(state[0]).toMatchObject({
        id: scheduleID,
        lastRanAt: ranAt,
        lastRunStatus: "ran",
      })

      const row = yield* Database.Service.use(({ db }) =>
        db
          .select()
          .from(ScheduleTable)
          .where(eq(ScheduleTable.id, scheduleID as never))
          .get()
          .pipe(Effect.orDie),
      )
      expect(row?.session_id).toBe(sessionID)
    }),
  )

  it.instance(
    "records a run for copied file-backed schedule state in the explicit target directory",
    Effect.gen(function* () {
      const schedules = yield* Schedule.Service
      const source = yield* TestInstance
      const target = yield* Effect.acquireRelease(
        Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "atree-schedule-record-target-"))),
        (dir) => Effect.promise(() => fs.rm(dir, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      const { db } = yield* Database.Service
      const sessionID = "ses_copied_schedule_record" as SessionID
      const scheduleID = "sch_copied_schedule_record"
      const now = Date.now()
      const ranAt = now + 1_000
      const storedSchedule = {
        id: scheduleID,
        sessionID,
        kind: "recurring" as const,
        expression: "* * * * *",
        runAt: null,
        message: "source copied schedule",
        createdAt: now,
        lastRanAt: null,
        lastRunStatus: null,
        nextRun: now + 60_000,
      }

      yield* db
        .insert(ProjectTable)
        .values({
          id: "proj_copied_schedule_record",
          worktree: source.directory,
          vcs: "git",
          name: "copied schedule record",
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
          project_id: "proj_copied_schedule_record",
          slug: "copied-schedule-record",
          directory: source.directory,
          title: "Copied schedule record",
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
          slug: "copied-schedule-record",
          version: "test",
          projectID: "proj_copied_schedule_record",
          directory: source.directory,
          path: ".",
          title: "Copied schedule record",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: now, updated: now },
        } as any),
      )
      yield* Effect.promise(() => writeSessionScheduleState(source.directory, sessionID, [storedSchedule]))
      expect(yield* schedules.list(sessionID, { directory: source.directory })).toHaveLength(1)
      const sourceBeforeRecord = yield* Effect.promise(() => readSessionScheduleState(source.directory, sessionID))
      yield* Effect.promise(() =>
        fs.cp(path.join(source.directory, ".agents"), path.join(target, ".agents"), { recursive: true }),
      )
      yield* Effect.promise(() =>
        writeSessionScheduleState(target, sessionID, [
          {
            ...storedSchedule,
            message: "target copied schedule",
          },
        ]),
      )

      yield* schedules.recordRun(scheduleID as Schedule.ID, sessionID, "ran", ranAt, { directory: target })

      expect(yield* Effect.promise(() => readSessionScheduleState(source.directory, sessionID))).toEqual(sourceBeforeRecord)
      expect(yield* Effect.promise(() => readSessionScheduleState(target, sessionID))).toMatchObject([
        {
          id: scheduleID,
          message: "target copied schedule",
          lastRanAt: ranAt,
          lastRunStatus: "ran",
        },
      ])
      const row = yield* db
        .select()
        .from(ScheduleTable)
        .where(eq(ScheduleTable.id, scheduleID as never))
        .get()
        .pipe(Effect.orDie)
      expect(row?.message).toBe("target copied schedule")
    }),
  )

  it.effect(
    "records a run for a file-backed schedule from the persisted atree root without a directory hint",
    Effect.gen(function* () {
      const data = yield* Effect.acquireRelease(
        Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "atree-schedule-record-data-"))),
        (dir) => Effect.promise(() => fs.rm(dir, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      const root = yield* tempdir
      const directory = path.join(root, "nodes", "automation")
      const previousData = Global.Path.data
      const sessionID = "ses_root_record_run_schedule" as SessionID
      const scheduleID = "sch_root_record_run"
      const now = Date.now()
      const ranAt = now + 1_000

      ;(Global.Path as { data: string }).data = data
      yield* Effect.addFinalizer(() => Effect.sync(() => ((Global.Path as { data: string }).data = previousData)))
      yield* Effect.promise(() => fs.mkdir(directory, { recursive: true }))
      yield* Effect.promise(() => writeWorkspaceRoot(root))
      yield* Effect.promise(() =>
        writeSessionStore({
          id: sessionID,
          slug: "root-record-run-schedule",
          version: "test",
          projectID: "proj_file",
          directory,
          path: "nodes/automation",
          title: "Root record run schedule",
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
            kind: "recurring",
            expression: "* * * * *",
            runAt: null,
            message: "record from persisted root",
            createdAt: now,
            lastRanAt: null,
            lastRunStatus: null,
            nextRun: now + 60_000,
          },
        ]),
      )

      yield* Schedule.Service.use((schedule) => schedule.recordRun(scheduleID as Schedule.ID, sessionID, "ran", ranAt))

      const state = yield* Effect.promise(() => readSessionScheduleState(directory, sessionID))
      expect(state).toHaveLength(1)
      expect(state[0]).toMatchObject({
        id: scheduleID,
        lastRanAt: ranAt,
        lastRunStatus: "ran",
      })

      const row = yield* Database.Service.use(({ db }) =>
        db
          .select()
          .from(ScheduleTable)
          .where(eq(ScheduleTable.id, scheduleID as never))
          .get()
          .pipe(Effect.orDie),
      )
      expect(row?.session_id).toBe(sessionID)
    }),
  )

  it.effect(
    "ticks a file-backed schedule from the persisted atree root without database rows",
    Effect.gen(function* () {
      const data = yield* Effect.acquireRelease(
        Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "atree-schedule-tick-data-"))),
        (dir) => Effect.promise(() => fs.rm(dir, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      const root = yield* tempdir
      const directory = path.join(root, "nodes", "tick")
      const previousData = Global.Path.data
      const sessionID = "ses_root_tick_schedule" as SessionID
      const scheduleID = "sch_root_tick_schedule"
      const now = Date.now()

      ;(Global.Path as { data: string }).data = data
      yield* Effect.addFinalizer(() => Effect.sync(() => ((Global.Path as { data: string }).data = previousData)))
      yield* Effect.promise(() => fs.mkdir(directory, { recursive: true }))
      yield* Effect.promise(() => writeWorkspaceRoot(root))
      yield* Effect.promise(() =>
        writeSessionStore({
          id: sessionID,
          slug: "root-tick-schedule",
          version: "test",
          projectID: "proj_file",
          directory,
          path: "nodes/tick",
          title: "Root tick schedule",
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
            message: "tick from persisted root",
            createdAt: now,
            lastRanAt: null,
            lastRunStatus: null,
            nextRun: now + 60_000,
          },
        ]),
      )

      yield* Schedule.Service.use((schedule) => schedule.tick(scheduleID as Schedule.ID))

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

      const raw = yield* Effect.promise(() =>
        fs.readFile(path.join(directory, ".agents", "atree", "sessions", sessionID, "session.jsonl"), "utf8"),
      )
      const entries = raw
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, any>)
      expect(entries.map((entry) => entry.type)).toContain("schedule.ran")
      expect(entries.at(-1)).toMatchObject({
        type: "schedule.deleted",
        scheduleID,
        sessionID,
        reason: "completed",
      })
    }),
  )

  it.effect(
    "clears a completed once schedule from directory state after it fires",
    Effect.gen(function* () {
      const directory = yield* tempdir
      const sessionID = "ses_once_schedule_completed" as SessionID
      const now = Date.now()

      yield* Effect.promise(() =>
        writeSessionStore({
          id: sessionID,
          slug: "once-schedule-completed",
          version: "test",
          projectID: "proj_once_schedule_completed",
          directory,
          path: ".",
          title: "Once schedule completed",
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
          message: "run once and disappear",
        }),
      )

      expect(yield* Effect.promise(() => readSessionScheduleState(directory, sessionID))).toHaveLength(1)

      yield* Schedule.Service.use((schedule) => schedule.tick(created.id))

      expect(yield* Effect.promise(() => readSessionScheduleState(directory, sessionID))).toEqual([])
      const row = yield* Database.Service.use(({ db }) =>
        db
          .select()
          .from(ScheduleTable)
          .where(eq(ScheduleTable.id, created.id as never))
          .get()
          .pipe(Effect.orDie),
      )
      expect(row).toBeUndefined()

      const raw = yield* Effect.promise(() =>
        fs.readFile(path.join(directory, ".agents", "atree", "sessions", sessionID, "session.jsonl"), "utf8"),
      )
      const entries = raw
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, any>)
      expect(entries.map((entry) => entry.type)).toContain("schedule.ran")
      expect(entries.at(-1)).toMatchObject({
        type: "schedule.deleted",
        scheduleID: created.id,
        sessionID,
        reason: "completed",
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
      expect(row).toBeUndefined()
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
    "prefers directory run state over stale schedule run rows when listing",
    Effect.gen(function* () {
      const directory = yield* tempdir
      const { db } = yield* Database.Service
      const sessionID = "ses_schedule_stale_run_rows" as SessionID
      const scheduleID = "sch_schedule_stale_run_rows"
      const now = Date.now()

      yield* db
        .insert(ProjectTable)
        .values({
          id: "proj_schedule_stale_run_rows",
          worktree: directory,
          vcs: "git",
          name: "schedule stale run rows",
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
          project_id: "proj_schedule_stale_run_rows",
          slug: "schedule-stale-run-rows",
          directory,
          title: "Schedule stale run rows",
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
          slug: "schedule-stale-run-rows",
          version: "test",
          projectID: "proj_schedule_stale_run_rows",
          directory,
          path: ".",
          title: "Schedule stale run rows",
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
            kind: "recurring",
            expression: "* * * * *",
            runAt: null,
            message: "directory run state wins",
            createdAt: now,
            lastRanAt: null,
            lastRunStatus: null,
            nextRun: now + 60_000,
          },
        ]),
      )
      yield* db
        .insert(ScheduleTable)
        .values({
          id: scheduleID as never,
          session_id: sessionID,
          kind: "recurring",
          expression: "* * * * *",
          run_at: null,
          message: "directory run state wins",
          created_at: now,
        })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(ScheduleRunTable)
        .values({
          id: "shr_schedule_stale_run_rows" as never,
          schedule_id: scheduleID as never,
          ran_at: now - 5_000,
          status: "ran",
        })
        .run()
        .pipe(Effect.orDie)

      const schedules = yield* Schedule.Service.use((schedule) => schedule.list(sessionID, { directory }))

      expect(schedules).toHaveLength(1)
      expect(schedules[0]).toMatchObject({
        id: scheduleID,
        lastRanAt: null,
        lastRunStatus: null,
      })
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
        fs.writeFile(
          path.join(directory, ".agents", "atree", "sessions", sessionID, "schedule.json"),
          JSON.stringify({
            version: 1,
            updatedAt: now + 20_000,
            schedules: [
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
            ],
          }),
        ),
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

      const schedules = yield* Schedule.Service.use((schedule) => schedule.list(sessionID, { directory }))

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

      const schedules = yield* Schedule.Service.use((schedule) => schedule.list(sessionID, { directory }))

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

      const schedules = yield* Schedule.Service.use((schedule) => schedule.list(sessionID, { directory }))

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

  it.effect(
    "does not trigger a stale database schedule when the directory schedule state is empty",
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const events = yield* EventV2Bridge.Service
      const data = yield* Effect.acquireRelease(
        Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "atree-schedule-empty-tick-data-"))),
        (dir) => Effect.promise(() => fs.rm(dir, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "atree-schedule-empty-tick-root-"))),
        (dir) => Effect.promise(() => fs.rm(dir, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      const previousData = Global.Path.data
      ;(Global.Path as { data: string }).data = data
      yield* Effect.addFinalizer(() => Effect.sync(() => ((Global.Path as { data: string }).data = previousData)))

      const staleDirectory = path.join(root, "old")
      const actualDirectory = path.join(root, "new")
      const sessionID = "ses_empty_tick_schedule" as SessionID
      const scheduleID = "sch_empty_tick_schedule"
      const now = Date.now()
      yield* Effect.promise(() => fs.mkdir(staleDirectory, { recursive: true }))
      yield* Effect.promise(() => fs.mkdir(actualDirectory, { recursive: true }))
      yield* Effect.promise(() => writeWorkspaceRoot(root))
      yield* db
        .insert(ProjectTable)
        .values({
          id: "proj_empty_tick_schedule",
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
          project_id: "proj_empty_tick_schedule",
          slug: "empty-tick-schedule",
          directory: staleDirectory,
          title: "Empty tick schedule",
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
          message: "phantom database schedule",
          created_at: now,
        })
        .run()
        .pipe(Effect.orDie)
      yield* Effect.promise(() =>
        writeSessionStore({
          id: sessionID,
          slug: "actual-empty-tick-schedule",
          version: "test",
          projectID: "proj_actual_empty_tick_schedule",
          directory: actualDirectory,
          path: "new",
          title: "Actual empty tick schedule",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: now, updated: now },
        } as any),
      )
      yield* Effect.promise(() => writeSessionScheduleState(actualDirectory, sessionID, []))

      const triggered: unknown[] = []
      const unsubscribe = yield* events.listen((event) =>
        Effect.sync(() => {
          if (event.type === "schedule.triggered") triggered.push(event)
        }),
      )
      yield* Effect.addFinalizer(() => unsubscribe)

      yield* Schedule.Service.use((schedule) => schedule.tick(scheduleID as never))

      expect(triggered).toEqual([])
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
    "uses archived file metadata to clear directory schedule state without rewriting a stale database session row",
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
      expect(row?.title).toBe("Stale active cache")
      expect(row?.archived).toBeNull()
    }),
  )
})
