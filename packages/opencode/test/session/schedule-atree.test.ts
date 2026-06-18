import { describe, expect } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Database } from "@opencode-ai/core/database/database"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { Effect, Layer } from "effect"
import { eq } from "drizzle-orm"
import { writeSessionScheduleState } from "../../src/atree/schedule-store"
import { writeSessionStore } from "../../src/atree/session-store"
import { Schedule } from "../../src/session/schedule"
import { ScheduleTable } from "../../src/session/schedule.sql"
import type { SessionID } from "../../src/session/schema"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

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
})
