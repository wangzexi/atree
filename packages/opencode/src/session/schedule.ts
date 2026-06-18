import { EffectBridge } from "../effect/bridge"
import { EventV2Bridge } from "../event-v2-bridge"
import { Identifier } from "../id/id"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { Cron } from "croner"
import { desc, eq, sql as drizzleSql } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { SessionID } from "./schema"
import { ScheduleRunTable, ScheduleTable } from "./schedule.sql"
import { SessionStatus } from "./status"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { readSessionScheduleState, writeSessionScheduleState } from "@/atree/schedule-store"
import { readSessionStore, readSessionStores } from "@/atree/session-store"
import { InstanceState } from "@/effect/instance-state"

export const MAX_PER_SESSION = 1
export const MIN_INTERVAL_MS = 60_000

export const ID = Schema.String.pipe(Schema.brand("ScheduleID"))
export type ID = Schema.Schema.Type<typeof ID>

export type Kind = "once" | "recurring"
export const KindSchema = Schema.Literals(["once", "recurring"])

export type RunStatus = "ran" | "skipped"
export const RunStatusSchema = Schema.Literals(["ran", "skipped"])

export const Info = Schema.Struct({
  id: ID,
  sessionID: SessionID,
  kind: KindSchema,
  expression: Schema.String,
  runAt: Schema.NullOr(Schema.Number),
  message: Schema.String,
  createdAt: Schema.Number,
  lastRanAt: Schema.NullOr(Schema.Number),
  lastRunStatus: Schema.NullOr(RunStatusSchema),
  nextRun: Schema.NullOr(Schema.Number),
}).annotate({ identifier: "Schedule" })
export type Info = Schema.Schema.Type<typeof Info>

type FileSession = NonNullable<Awaited<ReturnType<typeof readSessionStore>>>

export const Event = {
  Created: EventV2.define({
    type: "schedule.created",
    schema: { scheduleID: ID, sessionID: SessionID },
  }),
  Deleted: EventV2.define({
    type: "schedule.deleted",
    schema: { scheduleID: ID, sessionID: SessionID },
  }),
  Ran: EventV2.define({
    type: "schedule.ran",
    schema: {
      scheduleID: ID,
      sessionID: SessionID,
      status: RunStatusSchema,
      ranAt: Schema.Number,
    },
  }),
  /**
   * Emitted on every cron tick. The downstream runner is responsible for
   * deciding whether to actually inject a message (busy check) and for
   * calling Schedule.recordRun afterwards.
   */
  Triggered: EventV2.define({
    type: "schedule.triggered",
    schema: {
      scheduleID: ID,
      sessionID: SessionID,
      message: Schema.String,
    },
  }),
}

export class InvalidExpression extends Schema.TaggedErrorClass<InvalidExpression>()("ScheduleInvalidExpression", {
  expression: Schema.String,
  reason: Schema.String,
}) {}

export class InvalidRunAt extends Schema.TaggedErrorClass<InvalidRunAt>()("ScheduleInvalidRunAt", {
  runAt: Schema.Number,
  reason: Schema.String,
}) {}

export class IntervalTooShort extends Schema.TaggedErrorClass<IntervalTooShort>()("ScheduleIntervalTooShort", {
  expression: Schema.String,
  intervalMs: Schema.Number,
}) {}

export class LimitExceeded extends Schema.TaggedErrorClass<LimitExceeded>()("ScheduleLimitExceeded", {
  sessionID: SessionID,
  limit: Schema.Number,
}) {}

export class NotFound extends Schema.TaggedErrorClass<NotFound>()("ScheduleNotFound", {
  scheduleID: ID,
}) {}

export interface Interface {
  readonly list: (sessionID: SessionID) => Effect.Effect<Info[]>
  readonly create: (input: {
    sessionID: SessionID
    kind?: Kind
    expression?: string
    runAt?: number
    message: string
  }) => Effect.Effect<Info, InvalidExpression | InvalidRunAt | IntervalTooShort | LimitExceeded>
  readonly delete: (scheduleID: ID) => Effect.Effect<void, NotFound>
  /** Manually fire the tick for a schedule (publishes Triggered). */
  readonly tick: (scheduleID: ID) => Effect.Effect<void>
  /** Record that a fire was processed by the runner. */
  readonly recordRun: (scheduleID: ID, sessionID: SessionID, status: RunStatus, ranAt: number) => Effect.Effect<void>
  /** Remove every scheduled message for a session. */
  readonly clear: (sessionID: SessionID) => Effect.Effect<void>
  /** Restore scheduled messages for every file-backed session in a directory. */
  readonly restoreDirectory: (directory: string) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Schedule") {}

function validateExpression(expression: string): Effect.Effect<Cron, InvalidExpression | IntervalTooShort> {
  return Effect.gen(function* () {
    let cron: Cron
    try {
      cron = new Cron(expression, { paused: true })
    } catch (e) {
      return yield* Effect.fail(
        new InvalidExpression({
          expression,
          reason: e instanceof Error ? e.message : String(e),
        }),
      )
    }
    const next = cron.nextRuns(2)
    if (next.length < 2) {
      return yield* Effect.fail(
        new InvalidExpression({
          expression,
          reason: "expression does not produce two future runs",
        }),
      )
    }
    const intervalMs = next[1].getTime() - next[0].getTime()
    if (intervalMs < MIN_INTERVAL_MS) {
      return yield* Effect.fail(new IntervalTooShort({ expression, intervalMs }))
    }
    return cron
  })
}

function validateRunAt(runAt: number | undefined): Effect.Effect<number, InvalidRunAt> {
  return Effect.gen(function* () {
    if (typeof runAt !== "number" || !Number.isFinite(runAt)) {
      return yield* Effect.fail(
        new InvalidRunAt({
          runAt: Number.NaN,
          reason: "runAt must be a millisecond timestamp",
        }),
      )
    }
    const min = Date.now() + 1_000
    if (runAt < min) {
      return yield* Effect.fail(
        new InvalidRunAt({
          runAt,
          reason: "runAt must be in the future",
        }),
      )
    }
    return runAt
  })
}

type Timer =
  | { kind: "recurring"; cron: Cron; sessionID: SessionID; bridge: EffectBridge.Shape }
  | {
      kind: "once"
      timeout: ReturnType<typeof setTimeout>
      sessionID: SessionID
      runAt: number
      bridge: EffectBridge.Shape
    }

function stopTimer(timer: Timer) {
  if (timer.kind === "recurring") timer.cron.stop()
  else clearTimeout(timer.timeout)
}

function stopSessionTimers(timers: Map<ID, Timer>, sessionID: SessionID) {
  for (const [id, timer] of timers.entries()) {
    if (timer.sessionID !== sessionID) continue
    stopTimer(timer)
    timers.delete(id)
  }
}

function canRestoreStoredSchedule(schedule: {
  kind: Kind
  expression: string
  runAt: number | null
  lastRanAt: number | null
}) {
  if (schedule.kind === "once") return typeof schedule.runAt === "number" && schedule.lastRanAt === null
  try {
    new Cron(schedule.expression, { paused: true })
    return true
  } catch {
    return false
  }
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const { db } = yield* Database.Service

    const timers = new Map<ID, Timer>()
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const timer of timers.values()) {
          stopTimer(timer)
        }
        timers.clear()
      }),
    )

    const recordRun: Interface["recordRun"] = Effect.fn("Schedule.recordRun")(
      function* (scheduleID, sessionID, runStatus, ranAt) {
        yield* db
          .transaction((tx) =>
            tx
              .insert(ScheduleRunTable)
              .values({
                id: Identifier.create("shr", "ascending"),
                schedule_id: scheduleID,
                ran_at: ranAt,
                status: runStatus,
              })
              .run(),
          )
          .pipe(Effect.orDie)
        yield* events.publish(Event.Ran, { scheduleID, sessionID, status: runStatus, ranAt })
        yield* syncScheduleState(sessionID)
      },
    )

    const completeOnce = Effect.fn("Schedule.completeOnce")(function* (scheduleID: ID, sessionID: SessionID) {
      const timer = timers.get(scheduleID)
      if (timer) stopTimer(timer)
      timers.delete(scheduleID)
      yield* db.delete(ScheduleTable).where(eq(ScheduleTable.id, scheduleID)).run().pipe(Effect.orDie)
      yield* events.publish(Event.Deleted, { scheduleID, sessionID })
      yield* syncScheduleState(sessionID)
    })

    const getLastRun = Effect.fn("Schedule.getLastRun")(function* (scheduleID: ID) {
      return yield* db
        .select({
          ran_at: ScheduleRunTable.ran_at,
          status: ScheduleRunTable.status,
        })
        .from(ScheduleRunTable)
        .where(eq(ScheduleRunTable.schedule_id, scheduleID))
        .orderBy(desc(ScheduleRunTable.ran_at))
        .limit(1)
        .get()
        .pipe(Effect.orDie)
    })

    const upsertFileSessionCache = Effect.fn("Schedule.upsertFileSessionCache")(function* (session: FileSession) {
      const ctx = yield* InstanceState.context.pipe(Effect.catchCause(() => Effect.succeed(undefined)))
      const tokens = session.tokens ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
      const row = {
        id: session.id,
        project_id: ctx?.project.id ?? session.projectID,
        workspace_id: session.workspaceID ?? null,
        parent_id: session.parentID ?? null,
        slug: session.slug,
        directory: session.directory,
        path: session.path ?? null,
        title: session.title,
        agent: session.agent ?? null,
        model: session.model ?? null,
        version: session.version,
        share_url: session.share?.url ?? null,
        summary_additions: session.summary?.additions ?? null,
        summary_deletions: session.summary?.deletions ?? null,
        summary_files: session.summary?.files ?? null,
        summary_diffs: session.summary?.diffs ?? null,
        revert: session.revert ?? null,
        metadata: session.metadata ?? null,
        permission: session.permission ?? null,
        cost: session.cost,
        tokens_input: tokens.input,
        tokens_output: tokens.output,
        tokens_reasoning: tokens.reasoning,
        tokens_cache_read: tokens.cache.read,
        tokens_cache_write: tokens.cache.write,
        time_created: session.time.created,
        time_updated: session.time.updated,
        time_compacting: session.time.compacting ?? null,
        time_archived: session.time.archived ?? null,
      } as typeof SessionTable.$inferInsert
      yield* db
        .insert(SessionTable)
        .values(row)
        .onConflictDoUpdate({ target: SessionTable.id, set: row })
        .run()
        .pipe(Effect.orDie)
    })

    const sessionDirectory = Effect.fn("Schedule.sessionDirectory")(function* (sessionID: SessionID) {
      const row = yield* db
        .select({ directory: SessionTable.directory })
        .from(SessionTable)
        .where(eq(SessionTable.id, sessionID))
        .get()
        .pipe(Effect.orDie)
      if (row?.directory) {
        const fileSession = yield* Effect.promise(() => readSessionStore(row.directory, sessionID))
        if (fileSession) {
          yield* upsertFileSessionCache(fileSession)
          return fileSession.directory
        }
        return row.directory
      }

      const directory = yield* InstanceState.directory.pipe(
        Effect.catchCause(() => Effect.succeed<string | undefined>(undefined)),
      )
      if (!directory) return
      const session = yield* Effect.promise(() => readSessionStore(directory, sessionID))
      if (!session) return
      yield* upsertFileSessionCache(session)
      return session?.directory
    })

    const sessionArchiveState = Effect.fn("Schedule.sessionArchiveState")(function* (sessionID: SessionID) {
      const row = yield* db
        .select({ directory: SessionTable.directory, archived: SessionTable.time_archived })
        .from(SessionTable)
        .where(eq(SessionTable.id, sessionID))
        .get()
        .pipe(Effect.orDie)
      if (row?.directory) {
        const fileSession = yield* Effect.promise(() => readSessionStore(row.directory, sessionID))
        if (fileSession) {
          yield* upsertFileSessionCache(fileSession)
          return { directory: fileSession.directory, archived: fileSession.time.archived !== undefined }
        }
        return { directory: row.directory, archived: row.archived !== null }
      }

      const directory = yield* InstanceState.directory.pipe(
        Effect.catchCause(() => Effect.succeed<string | undefined>(undefined)),
      )
      if (!directory) return
      const session = yield* Effect.promise(() => readSessionStore(directory, sessionID))
      if (!session) return
      return { directory: session.directory, archived: session.time.archived !== undefined }
    })

    const activeSchedules = Effect.fn("Schedule.activeSchedules")(function* (sessionID: SessionID) {
      const rows = yield* db
        .select({
          id: ScheduleTable.id,
          session_id: ScheduleTable.session_id,
          kind: ScheduleTable.kind,
          expression: ScheduleTable.expression,
          run_at: ScheduleTable.run_at,
          message: ScheduleTable.message,
          created_at: ScheduleTable.created_at,
        })
        .from(ScheduleTable)
        .where(eq(ScheduleTable.session_id, sessionID))
        .all()
        .pipe(Effect.orDie)

      return yield* Effect.all(
        rows.map((row) =>
          Effect.gen(function* () {
            const id = row.id as ID
            const kind = (row.kind ?? "recurring") as Kind
            const lastRun = yield* getLastRun(id)
            const timer = timers.get(id)
            const nextRun =
              timer?.kind === "recurring" ? (timer.cron.nextRun()?.getTime() ?? null) : (timer?.runAt ?? null)
            return {
              id,
              sessionID: row.session_id as SessionID,
              kind,
              expression: row.expression,
              runAt: row.run_at ?? null,
              message: row.message,
              createdAt: row.created_at,
              lastRanAt: lastRun?.ran_at ?? null,
              lastRunStatus: (lastRun?.status as RunStatus | undefined) ?? null,
              nextRun,
            } satisfies Info
          }),
        ),
      )
    })

    const syncScheduleState = Effect.fn("Schedule.syncScheduleState")(function* (sessionID: SessionID) {
      const directory = yield* sessionDirectory(sessionID)
      if (!directory) return
      const schedules = yield* activeSchedules(sessionID)
      yield* Effect.promise(() => writeSessionScheduleState(directory, sessionID, schedules))
    })

    const cleanupCompletedOnceForSession = Effect.fn("Schedule.cleanupCompletedOnceForSession")(function* (
      sessionID: SessionID,
    ) {
      const rows = yield* db
        .select({
          id: ScheduleTable.id,
          session_id: ScheduleTable.session_id,
          kind: ScheduleTable.kind,
        })
        .from(ScheduleTable)
        .where(eq(ScheduleTable.session_id, sessionID))
        .all()
        .pipe(Effect.orDie)
      for (const row of rows) {
        if ((row.kind ?? "recurring") !== "once") continue
        const lastRun = yield* getLastRun(row.id as ID)
        if (lastRun) {
          yield* completeOnce(row.id as ID, row.session_id as SessionID)
        }
      }
    })

    const process = Effect.fn("Schedule.process")(function* (scheduleID: ID) {
      const row = yield* db
        .select()
        .from(ScheduleTable)
        .where(eq(ScheduleTable.id, scheduleID))
        .get()
        .pipe(Effect.orDie)
      if (!row) return
      const sessionID = row.session_id as SessionID
      const kind = (row.kind ?? "recurring") as Kind
      const message = row.message
      yield* events.publish(Event.Triggered, {
        scheduleID,
        sessionID,
        message,
      })
      const status = yield* SessionStatus.Service
      const sessionStatus = yield* status.get(sessionID)
      const ranAt = Date.now()
      if (sessionStatus.type === "busy") {
        yield* recordRun(scheduleID, sessionID, "skipped", ranAt)
        if (kind === "once") {
          yield* completeOnce(scheduleID, sessionID)
        }
        return
      }
      const { SessionPrompt } = yield* Effect.promise(() => import("./prompt"))
      const prompt = yield* SessionPrompt.Service
      yield* prompt
        .prompt({
          sessionID,
          parts: [
            {
              type: "text",
              text: message,
              metadata: { source: "schedule", scheduleId: scheduleID },
            },
          ],
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.sync(() =>
              console.error("schedule fire failed", {
                scheduleID,
                cause,
              }),
            ),
          ),
        )
      yield* recordRun(scheduleID, sessionID, "ran", ranAt)
      if (kind === "once") {
        yield* completeOnce(scheduleID, sessionID)
      }
    })

    function startTimer(
      scheduleID: ID,
      sessionID: SessionID,
      kind: Kind,
      expression: string,
      runAt: number | null,
      bridge: EffectBridge.Shape,
    ) {
      const existing = timers.get(scheduleID)
      if (existing) stopTimer(existing)
      if (kind === "once") {
        if (!runAt) return
        const timeout = setTimeout(
          () => {
            bridge.promise(process(scheduleID)).catch((e) =>
              console.error("schedule timer error", {
                scheduleID,
                error: e instanceof Error ? e.message : String(e),
              }),
            )
          },
          Math.max(0, runAt - Date.now()),
        )
        timers.set(scheduleID, { kind, timeout, sessionID, runAt, bridge })
        return
      }
      const cron = new Cron(expression, {}, () => {
        bridge.promise(process(scheduleID)).catch((e) =>
          console.error("schedule timer error", {
            scheduleID,
            error: e instanceof Error ? e.message : String(e),
          }),
        )
      })
      timers.set(scheduleID, { kind, cron, sessionID, bridge })
    }

    const tick: Interface["tick"] = Effect.fn("Schedule.tick")(function* (scheduleID) {
      const timer = timers.get(scheduleID)
      if (timer) {
        yield* Effect.promise(() => timer.bridge.promise(process(scheduleID)))
        return
      }
      const row = yield* db
        .select()
        .from(ScheduleTable)
        .where(eq(ScheduleTable.id, scheduleID))
        .get()
        .pipe(Effect.orDie)
      if (!row) return
      yield* events.publish(Event.Triggered, {
        scheduleID,
        sessionID: row.session_id as SessionID,
        message: row.message,
      })
    })

    const serviceBridge = yield* EffectBridge.make()
    const restoreStoredSchedules = Effect.fn("Schedule.restoreStoredSchedules")(function* (sessionID: SessionID) {
      const archiveState = yield* sessionArchiveState(sessionID)
      if (!archiveState) return [] as Info[]
      if (archiveState.archived) {
        stopSessionTimers(timers, sessionID)
        yield* db.delete(ScheduleTable).where(eq(ScheduleTable.session_id, sessionID)).run().pipe(Effect.orDie)
        yield* Effect.promise(() => writeSessionScheduleState(archiveState.directory, sessionID, []))
        return [] as Info[]
      }
      const directory = archiveState.directory
      yield* sessionDirectory(sessionID)
      const stored = yield* Effect.promise(() => readSessionScheduleState(directory, sessionID))
      if (stored.length === 0) return [] as Info[]

      const existing = yield* db
        .select({ id: ScheduleTable.id })
        .from(ScheduleTable)
        .where(eq(ScheduleTable.session_id, sessionID))
        .all()
        .pipe(Effect.orDie)
      const existingIDs = new Set(existing.map((row) => row.id))
      const sorted = [...stored].sort((a, b) => (a.nextRun ?? Number.MAX_SAFE_INTEGER) - (b.nextRun ?? Number.MAX_SAFE_INTEGER))

      for (const schedule of sorted.slice(0, MAX_PER_SESSION)) {
        if (existingIDs.has(schedule.id)) continue
        if (!canRestoreStoredSchedule(schedule)) continue
        const id = schedule.id as ID
        yield* db
          .transaction((tx) =>
            tx
              .insert(ScheduleTable)
              .values({
                id,
                session_id: sessionID,
                kind: schedule.kind,
                expression: schedule.expression,
                run_at: schedule.runAt,
                message: schedule.message,
                created_at: schedule.createdAt,
              })
              .run(),
          )
          .pipe(Effect.orDie)
        startTimer(id, sessionID, schedule.kind, schedule.expression, schedule.runAt, serviceBridge)
      }

      const schedules = yield* activeSchedules(sessionID)
      if (schedules.length > 0) yield* syncScheduleState(sessionID)
      return schedules
    })

    const hydrated = yield* db.select().from(ScheduleTable).all().pipe(Effect.orDie)
    for (const row of hydrated) {
      const id = row.id as ID
      const sessionID = row.session_id as SessionID
      const archiveState = yield* sessionArchiveState(sessionID)
      if (archiveState?.archived) {
        stopSessionTimers(timers, sessionID)
        yield* db.delete(ScheduleTable).where(eq(ScheduleTable.session_id, sessionID)).run().pipe(Effect.orDie)
        yield* Effect.promise(() => writeSessionScheduleState(archiveState.directory, sessionID, []))
        continue
      }
      const kind = (row.kind ?? "recurring") as Kind
      if (kind === "once") {
        const lastRun = yield* getLastRun(id)
        if (lastRun) {
          yield* completeOnce(id, sessionID)
          continue
        }
      }
      startTimer(id, sessionID, kind, row.expression, row.run_at ?? null, serviceBridge)
    }
    const sessions = yield* db.select({ id: SessionTable.id }).from(SessionTable).all().pipe(Effect.orDie)
    for (const session of sessions) {
      yield* restoreStoredSchedules(session.id as SessionID)
    }

    const restoreDirectory: Interface["restoreDirectory"] = Effect.fn("Schedule.restoreDirectory")(function* (directory) {
      const fileSessions = yield* Effect.promise(() => readSessionStores(directory))
      yield* Effect.forEach(
        fileSessions,
        (session) =>
          restoreStoredSchedules(session.id).pipe(
            Effect.catchCause((cause) => Effect.logWarning("failed to restore file-backed schedules", { cause })),
          ),
        { concurrency: "unbounded", discard: true },
      )
    })

    const list: Interface["list"] = Effect.fn("Schedule.list")(function* (sessionID: SessionID) {
      const archiveState = yield* sessionArchiveState(sessionID)
      if (archiveState?.archived) {
        stopSessionTimers(timers, sessionID)
        yield* db.delete(ScheduleTable).where(eq(ScheduleTable.session_id, sessionID)).run().pipe(Effect.orDie)
        yield* Effect.promise(() => writeSessionScheduleState(archiveState.directory, sessionID, []))
        return [] as Info[]
      }
      const rows = yield* db
        .select({
          id: ScheduleTable.id,
          session_id: ScheduleTable.session_id,
          kind: ScheduleTable.kind,
          expression: ScheduleTable.expression,
          run_at: ScheduleTable.run_at,
          message: ScheduleTable.message,
          created_at: ScheduleTable.created_at,
        })
        .from(ScheduleTable)
        .where(eq(ScheduleTable.session_id, sessionID))
        .all()
        .pipe(Effect.orDie)
      for (const row of rows) {
        const kind = (row.kind ?? "recurring") as Kind
        const lastRun = yield* getLastRun(row.id as ID)
        if (kind === "once" && lastRun) {
          yield* completeOnce(row.id as ID, row.session_id as SessionID)
        }
      }
      const items = yield* activeSchedules(sessionID)
      if (items.length > 0 || rows.length > 0) {
        yield* syncScheduleState(sessionID)
        return items
      }
      const directory = yield* sessionDirectory(sessionID)
      if (!directory) return items
      const restored = yield* restoreStoredSchedules(sessionID)
      if (restored.length > 0) return restored
      const stored = yield* Effect.promise(() => readSessionScheduleState(directory, sessionID))
      return stored.filter(canRestoreStoredSchedule).map((schedule) => ({
        ...schedule,
        id: schedule.id as ID,
        sessionID: schedule.sessionID as SessionID,
      }))
    })

    const create: Interface["create"] = Effect.fn("Schedule.create")(function* (input: {
      sessionID: SessionID
      kind?: Kind
      expression?: string
      runAt?: number
      message: string
    }) {
      const kind = input.kind ?? "recurring"
      const expression = kind === "recurring" ? input.expression?.trim() : input.expression?.trim() || ""
      const runAt = kind === "once" ? yield* validateRunAt(input.runAt) : null
      if (kind === "recurring") {
        if (!expression) {
          return yield* Effect.fail(new InvalidExpression({ expression: "", reason: "expression is required" }))
        }
        yield* validateExpression(expression)
      }
      yield* restoreStoredSchedules(input.sessionID)
      yield* cleanupCompletedOnceForSession(input.sessionID)
      const count = yield* db
        .select({ c: drizzleSql<number>`COUNT(*)` })
        .from(ScheduleTable)
        .where(eq(ScheduleTable.session_id, input.sessionID))
        .get()
        .pipe(Effect.orDie)
      if ((count?.c ?? 0) >= MAX_PER_SESSION) {
        return yield* Effect.fail(new LimitExceeded({ sessionID: input.sessionID, limit: MAX_PER_SESSION }))
      }
      const id = Identifier.create("sch", "ascending") as ID
      const createdAt = Date.now()
      yield* db
        .transaction((tx) =>
          tx
            .insert(ScheduleTable)
            .values({
              id,
              session_id: input.sessionID,
              kind,
              expression: expression || "",
              run_at: runAt,
              message: input.message,
              created_at: createdAt,
            })
            .run(),
        )
        .pipe(Effect.orDie)
      const bridge = yield* EffectBridge.make()
      startTimer(id, input.sessionID, kind, expression || "", runAt, bridge)
      yield* events.publish(Event.Created, { scheduleID: id, sessionID: input.sessionID })
      yield* syncScheduleState(input.sessionID)
      const createdTimer = timers.get(id)
      return {
        id,
        sessionID: input.sessionID,
        kind,
        expression: expression || "",
        runAt,
        message: input.message,
        createdAt,
        lastRanAt: null,
        lastRunStatus: null,
        nextRun:
          kind === "once"
            ? runAt
            : createdTimer?.kind === "recurring"
              ? (createdTimer.cron.nextRun()?.getTime() ?? null)
              : null,
      } satisfies Info
    })

    const deleteSchedule: Interface["delete"] = Effect.fn("Schedule.delete")(function* (scheduleID: ID) {
      const row = yield* db
        .select()
        .from(ScheduleTable)
        .where(eq(ScheduleTable.id, scheduleID))
        .get()
        .pipe(Effect.orDie)
      if (!row) return yield* Effect.fail(new NotFound({ scheduleID }))
      yield* db.delete(ScheduleTable).where(eq(ScheduleTable.id, scheduleID)).run().pipe(Effect.orDie)
      const timer = timers.get(scheduleID)
      if (timer) {
        stopTimer(timer)
        timers.delete(scheduleID)
      }
      yield* events.publish(Event.Deleted, {
        scheduleID,
        sessionID: row.session_id as SessionID,
      })
      yield* syncScheduleState(row.session_id as SessionID)
    })

    const clear: Interface["clear"] = Effect.fn("Schedule.clear")(function* (sessionID: SessionID) {
      stopSessionTimers(timers, sessionID)
      const rows = yield* db
        .select({ id: ScheduleTable.id })
        .from(ScheduleTable)
        .where(eq(ScheduleTable.session_id, sessionID))
        .all()
        .pipe(Effect.orDie)
      if (rows.length > 0) {
        yield* db.delete(ScheduleTable).where(eq(ScheduleTable.session_id, sessionID)).run().pipe(Effect.orDie)
      }
      for (const row of rows) {
        const id = row.id as ID
        yield* events.publish(Event.Deleted, { scheduleID: id, sessionID })
      }
      yield* syncScheduleState(sessionID)
    })

    return Service.of({
      list,
      create,
      delete: deleteSchedule,
      clear,
      tick,
      recordRun,
      restoreDirectory,
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Database.defaultLayer), Layer.provide(EventV2Bridge.defaultLayer))

export const node = LayerNode.make(layer, [Database.node, EventV2Bridge.node])

export * as Schedule from "./schedule"
