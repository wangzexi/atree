import { expect } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Database } from "@opencode-ai/core/database/database"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { sql } from "drizzle-orm"
import { Effect, Layer, Queue } from "effect"
import { GlobalBus, type GlobalEvent } from "../../src/bus/global"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { SessionPrompt } from "../../src/session/prompt"
import { Schedule } from "../../src/session/schedule"
import { SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { readSessionScheduleState } from "../../src/atree/schedule-store"
import { writeSessionStore } from "../../src/atree/session-store"
import { pollWithTimeout, testEffect } from "../lib/effect"

let promptQueue: Queue.Queue<SessionPrompt.PromptInput> | undefined

const promptLayer = Layer.effect(
  SessionPrompt.Service,
  Effect.gen(function* () {
    return SessionPrompt.Service.of({
      cancel: () => Effect.void,
      prompt: (input) =>
        Effect.gen(function* () {
          if (!promptQueue) return yield* Effect.die("prompt queue not set")
          yield* Queue.offer(promptQueue, input)
          if (input.parts.some((part) => part.type === "text" && part.text === "die after submit")) {
            return yield* Effect.die("submitted then failed")
          }
          return undefined as unknown as SessionV1.WithParts
        }),
      loop: () => Effect.succeed(undefined as unknown as SessionV1.WithParts),
      shell: () => Effect.succeed(undefined as unknown as SessionV1.WithParts),
      command: () => Effect.succeed(undefined as unknown as SessionV1.WithParts),
      resolvePromptParts: () => Effect.succeed([]),
    })
  }),
)

const events = EventV2Bridge.defaultLayer
const status = SessionStatus.layer.pipe(Layer.provideMerge(events))
const schedule = Schedule.layer.pipe(Layer.provideMerge(events))

const testLayer = Layer.mergeAll(promptLayer, events, status, schedule).pipe(Layer.provideMerge(Database.defaultLayer))

const it = testEffect(testLayer)

const takePrompt = (queue: Queue.Queue<SessionPrompt.PromptInput>) =>
  Effect.race(
    Queue.take(queue),
    Effect.sleep("2 seconds").pipe(Effect.flatMap(() => Effect.fail(new Error("timed out waiting for prompt")))),
  )

const waitForRunStatus = (schedules: Schedule.Interface, sessionID: SessionID, status: Schedule.RunStatus) =>
  pollWithTimeout(
    Effect.gen(function* () {
      const items = yield* schedules.list(sessionID)
      return items[0]?.lastRunStatus === status ? items[0] : undefined
    }),
    `timed out waiting for schedule run status ${status}`,
  )

const scheduleEventTypes = (events: GlobalEvent[], sessionID: SessionID) =>
  events.filter((event) => event.payload?.properties?.sessionID === sessionID).map((event) => event.payload?.type)

const initScheduleTables = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db.run(sql`CREATE TABLE IF NOT EXISTS schedule (
    id text PRIMARY KEY NOT NULL,
    session_id text NOT NULL,
    kind text DEFAULT 'recurring' NOT NULL,
    expression text NOT NULL,
    run_at integer,
    message text NOT NULL,
    created_at integer NOT NULL
  )`)
  yield* db.run(sql`CREATE INDEX IF NOT EXISTS schedule_session_idx ON schedule (session_id)`)
  yield* db.run(sql`CREATE TABLE IF NOT EXISTS schedule_run (
    id text PRIMARY KEY NOT NULL,
    schedule_id text NOT NULL,
    ran_at integer NOT NULL,
    status text NOT NULL
  )`)
  yield* db.run(sql`CREATE INDEX IF NOT EXISTS schedule_run_idx ON schedule_run (schedule_id, ran_at)`)
})

const createFixtureSession = (title: string) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const now = Date.now()
    const sessionID = SessionID.descending()
    yield* db.run(sql`
      INSERT OR IGNORE INTO project (
        id,
        worktree,
        name,
        time_created,
        time_updated,
        sandboxes
      ) VALUES (
        'prj_schedule_test',
        '/tmp/atree-schedule-test',
        'schedule test',
        ${now},
        ${now},
        '[]'
      )
    `)
    yield* db.run(sql`
      INSERT INTO session (
        id,
        project_id,
        slug,
        directory,
        title,
        version,
        time_created,
        time_updated
      ) VALUES (
        ${sessionID},
        'prj_schedule_test',
        ${title},
        '/tmp/atree-schedule-test',
        ${title},
        'test',
        ${now},
        ${now}
      )
    `)
    return { id: sessionID }
  })

it.instance("creates, lists, triggers, records, and deletes a scheduled task", () =>
  Effect.gen(function* () {
    const schedules = yield* Schedule.Service
    const queue = yield* Queue.unbounded<SessionPrompt.PromptInput>()
    promptQueue = queue
    yield* initScheduleTables

    const session = yield* createFixtureSession("schedule test")
    const events: GlobalEvent[] = []
    const onEvent = (event: GlobalEvent) => {
      events.push(event)
    }
    GlobalBus.on("event", onEvent)
    yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", onEvent)))

    const created = yield* schedules.create({
      sessionID: session.id,
      expression: "* * * * *",
      message: "scheduled hello",
    })

    expect((yield* schedules.list(session.id)).map((item) => item.id)).toEqual([created.id])
    expect(scheduleEventTypes(events, session.id)).toContain("schedule.created")

    yield* schedules.tick(created.id)
    const prompt = yield* takePrompt(queue)

    expect(prompt.sessionID).toBe(session.id)
    expect(prompt.parts).toEqual([
      {
        type: "text",
        text: "scheduled hello",
        metadata: { source: "schedule", scheduleId: created.id },
      },
    ])

    const ran = yield* waitForRunStatus(schedules, session.id, "ran")
    expect(ran.lastRanAt).toBeNumber()
    const directoryState = yield* Effect.promise(() => readSessionScheduleState("/tmp/atree-schedule-test", session.id))
    expect(directoryState[0]).toMatchObject({
      id: created.id,
      lastRanAt: ran.lastRanAt,
      lastRunStatus: "ran",
    })
    expect(scheduleEventTypes(events, session.id)).toContain("schedule.triggered")
    expect(scheduleEventTypes(events, session.id)).toContain("schedule.ran")

    yield* schedules.delete(created.id)
    expect(yield* schedules.list(session.id)).toEqual([])
    expect(scheduleEventTypes(events, session.id)).toContain("schedule.deleted")
  }),
)

it.instance("clears scheduled tasks and directory schedule state for a session", () =>
  Effect.gen(function* () {
    const schedules = yield* Schedule.Service
    yield* initScheduleTables

    const session = yield* createFixtureSession("schedule clear test")
    const events: GlobalEvent[] = []
    const onEvent = (event: GlobalEvent) => {
      events.push(event)
    }
    GlobalBus.on("event", onEvent)
    yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", onEvent)))

    const created = yield* schedules.create({
      sessionID: session.id,
      expression: "* * * * *",
      message: "clear me",
    })
    expect(yield* Effect.promise(() => readSessionScheduleState("/tmp/atree-schedule-test", session.id))).toHaveLength(
      1,
    )

    yield* schedules.clear(session.id)
    expect(yield* schedules.list(session.id)).toEqual([])
    expect(yield* Effect.promise(() => readSessionScheduleState("/tmp/atree-schedule-test", session.id))).toEqual([])
    expect(scheduleEventTypes(events, session.id)).toContain("schedule.deleted")
    expect(scheduleEventTypes(events, session.id).filter((event) => event === "schedule.deleted")).toHaveLength(1)
    expect(created.id).toBeTruthy()
  }),
)

it.instance("does not list scheduled tasks for archived sessions", () =>
  Effect.gen(function* () {
    const schedules = yield* Schedule.Service
    const { db } = yield* Database.Service
    yield* initScheduleTables

    const session = yield* createFixtureSession("schedule archived test")
    yield* schedules.create({
      sessionID: session.id,
      expression: "* * * * *",
      message: "do not list after archive",
    })
    expect(yield* Effect.promise(() => readSessionScheduleState("/tmp/atree-schedule-test", session.id))).toHaveLength(
      1,
    )

    yield* db.run(sql`UPDATE session SET time_archived = ${Date.now()} WHERE id = ${session.id}`).pipe(Effect.orDie)

    expect(yield* schedules.list(session.id)).toEqual([])
    expect(yield* Effect.promise(() => readSessionScheduleState("/tmp/atree-schedule-test", session.id))).toEqual([])
  }),
)

it.instance("runs a one-time scheduled task once", () =>
  Effect.gen(function* () {
    const schedules = yield* Schedule.Service
    const queue = yield* Queue.unbounded<SessionPrompt.PromptInput>()
    promptQueue = queue
    yield* initScheduleTables

    const session = yield* createFixtureSession("schedule once test")
    const events: GlobalEvent[] = []
    const onEvent = (event: GlobalEvent) => {
      events.push(event)
    }
    GlobalBus.on("event", onEvent)
    yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", onEvent)))
    const runAt = Date.now() + 60_000
    const created = yield* schedules.create({
      sessionID: session.id,
      kind: "once",
      runAt,
      message: "scheduled once",
    })

    expect(created.kind).toBe("once")
    expect(created.runAt).toBe(runAt)
    expect(created.nextRun).toBe(runAt)

    yield* schedules.tick(created.id)
    const prompt = yield* takePrompt(queue)
    expect(prompt.parts).toEqual([
      {
        type: "text",
        text: "scheduled once",
        metadata: { source: "schedule", scheduleId: created.id },
      },
    ])

    expect(yield* schedules.list(session.id)).toEqual([])
    expect(yield* Effect.promise(() => readSessionScheduleState("/tmp/atree-schedule-test", session.id))).toEqual([])
    expect(scheduleEventTypes(events, session.id)).toContain("schedule.ran")
    expect(scheduleEventTypes(events, session.id)).toContain("schedule.deleted")

    const next = yield* schedules.create({
      sessionID: session.id,
      kind: "once",
      runAt: Date.now() + 120_000,
      message: "scheduled once again",
    })
    expect(next.kind).toBe("once")
  }),
)

it.instance("clears a one-time scheduled task when the session is busy", () =>
  Effect.gen(function* () {
    const schedules = yield* Schedule.Service
    const status = yield* SessionStatus.Service
    promptQueue = yield* Queue.unbounded<SessionPrompt.PromptInput>()
    yield* initScheduleTables

    const session = yield* createFixtureSession("schedule once busy test")
    yield* status.set(session.id, { type: "busy" })
    const events: GlobalEvent[] = []
    const onEvent = (event: GlobalEvent) => {
      events.push(event)
    }
    GlobalBus.on("event", onEvent)
    yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", onEvent)))

    const created = yield* schedules.create({
      sessionID: session.id,
      kind: "once",
      runAt: Date.now() + 60_000,
      message: "scheduled once while busy",
    })

    yield* schedules.tick(created.id)

    expect(yield* schedules.list(session.id)).toEqual([])
    expect(yield* Effect.promise(() => readSessionScheduleState("/tmp/atree-schedule-test", session.id))).toEqual([])
    expect(scheduleEventTypes(events, session.id)).toContain("schedule.ran")
    expect(scheduleEventTypes(events, session.id)).toContain("schedule.deleted")
  }),
)

it.instance("clears a one-time scheduled task in the file-backed directory that created its timer", () =>
  Effect.gen(function* () {
    const schedules = yield* Schedule.Service
    const queue = yield* Queue.unbounded<SessionPrompt.PromptInput>()
    promptQueue = queue
    const { db } = yield* Database.Service
    yield* initScheduleTables

    const target = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "atree-schedule-target-")))
    const stale = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "atree-schedule-stale-")))
    yield* Effect.addFinalizer(() =>
      Effect.promise(() => fs.rm(target, { recursive: true, force: true })).pipe(Effect.ignore),
    )
    yield* Effect.addFinalizer(() =>
      Effect.promise(() => fs.rm(stale, { recursive: true, force: true })).pipe(Effect.ignore),
    )

    const now = Date.now()
    const sessionID = SessionID.descending()
    yield* Effect.promise(() =>
      writeSessionStore({
        id: sessionID,
        slug: "file-backed-once",
        version: "test",
        projectID: "proj_file_backed_once",
        directory: target,
        path: ".",
        title: "File backed once",
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: now, updated: now },
      } as any),
    )

    const created = yield* schedules.create({
      sessionID,
      directory: target,
      kind: "once",
      runAt: now + 60_000,
      message: "run in target directory",
    })
    expect(yield* Effect.promise(() => readSessionScheduleState(target, sessionID))).toHaveLength(1)

    yield* db.run(sql`UPDATE session SET directory = ${stale} WHERE id = ${sessionID}`).pipe(Effect.orDie)

    yield* schedules.tick(created.id)
    const prompt = yield* takePrompt(queue)
    expect(prompt.sessionID).toBe(sessionID)
    expect(yield* Effect.promise(() => readSessionScheduleState(target, sessionID))).toEqual([])
    expect(yield* Effect.promise(() => readSessionScheduleState(stale, sessionID))).toEqual([])
  }),
)

it.instance("rejects a second scheduled task for the same session", () =>
  Effect.gen(function* () {
    const schedules = yield* Schedule.Service
    promptQueue = yield* Queue.unbounded<SessionPrompt.PromptInput>()
    yield* initScheduleTables

    const session = yield* createFixtureSession("schedule single automation test")
    yield* schedules.create({
      sessionID: session.id,
      expression: "* * * * *",
      message: "first automation",
    })

    const error = yield* schedules
      .create({
        sessionID: session.id,
        expression: "*/5 * * * *",
        message: "second automation",
      })
      .pipe(Effect.flip)

    expect(error._tag).toBe("ScheduleLimitExceeded")
    if (error._tag === "ScheduleLimitExceeded") {
      expect(error.limit).toBe(1)
    }
  }),
)

it.instance("records a skipped run when the session is busy", () =>
  Effect.gen(function* () {
    const schedules = yield* Schedule.Service
    const status = yield* SessionStatus.Service
    promptQueue = yield* Queue.unbounded<SessionPrompt.PromptInput>()
    yield* initScheduleTables

    const session = yield* createFixtureSession("schedule busy test")
    yield* status.set(session.id, { type: "busy" })

    const created = yield* schedules.create({
      sessionID: session.id,
      expression: "* * * * *",
      message: "scheduled while busy",
    })

    yield* schedules.tick(created.id)
    const skipped = yield* waitForRunStatus(schedules, session.id, "skipped")
    expect(skipped.lastRanAt).toBeNumber()
  }),
)

it.instance("records a ran status when prompt submission fails after adding the message", () =>
  Effect.gen(function* () {
    const schedules = yield* Schedule.Service
    promptQueue = yield* Queue.unbounded<SessionPrompt.PromptInput>()
    yield* initScheduleTables

    const session = yield* createFixtureSession("schedule prompt failure test")
    const created = yield* schedules.create({
      sessionID: session.id,
      expression: "* * * * *",
      message: "die after submit",
    })

    yield* schedules.tick(created.id)
    const ran = yield* waitForRunStatus(schedules, session.id, "ran")
    expect(ran.lastRanAt).toBeNumber()
  }),
)
