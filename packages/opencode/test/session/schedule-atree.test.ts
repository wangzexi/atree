import { describe, expect } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Database } from "@opencode-ai/core/database/database"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { Effect, Layer } from "effect"
import { eq } from "drizzle-orm"
import { readSessionScheduleState, writeSessionScheduleState } from "../../src/atree/schedule-store"
import { writeSessionStore } from "../../src/atree/session-store"
import { Schedule } from "../../src/session/schedule"
import { ScheduleTable } from "../../src/session/schedule.sql"
import type { SessionID } from "../../src/session/schema"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { InstanceState } from "@/effect/instance-state"

const it = testEffect(Layer.mergeAll(Schedule.defaultLayer, Database.defaultLayer))

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
      expect(schedules[0]).toMatchObject({ id: "sch_explicit_list", sessionID, message: "list with explicit directory" })

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
      yield* Effect.promise(() => fs.cp(path.join(source.directory, ".agents"), path.join(target, ".agents"), { recursive: true }))

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
