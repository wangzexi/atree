import { EffectBridge } from "../effect/bridge"
import { EventV2Bridge } from "../event-v2-bridge"
import { Identifier } from "../id/id"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import fs from "fs/promises"
import path from "path"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Cron } from "croner"
import { eq, inArray } from "drizzle-orm"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Location } from "@opencode-ai/core/location"
import { SessionID } from "./schema"
import { ScheduleRunTable, ScheduleTable } from "./schedule.sql"
import { SessionStatus } from "./status"
import {
  findSessionScheduleState,
  findWorkspaceSessionScheduleState,
  readSessionScheduleProjection,
  readSessionScheduleState,
  writeSessionScheduleState,
} from "@/atree/schedule-store"
import {
  appendSessionJsonl,
  findWorkspaceSessionStores,
  readSessionStore,
  readSessionStores,
  readSessionStoresDeep,
  touchSessionStore,
} from "@/atree/session-store"
import { resolveFileSession } from "@/atree/session-resolver"
import { readWorkspaceRootDirectory } from "@/atree/state"
import { InstanceRef } from "@/effect/instance-ref"

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
type SessionLocation =
  | { type: "found"; directory: string; archived: boolean }
  | { type: "missing" }
  | { type: "none" }

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

export class SessionNotFound extends Schema.TaggedErrorClass<SessionNotFound>()("ScheduleSessionNotFound", {
  sessionID: SessionID,
}) {}

export class NotFound extends Schema.TaggedErrorClass<NotFound>()("ScheduleNotFound", {
  scheduleID: ID,
}) {}

export interface Interface {
  readonly list: (sessionID: SessionID, options?: { directory?: string }) => Effect.Effect<Info[]>
  readonly create: (input: {
    sessionID: SessionID
    kind?: Kind
    expression?: string
    runAt?: number
    message: string
    directory?: string
  }) => Effect.Effect<Info, InvalidExpression | InvalidRunAt | IntervalTooShort | LimitExceeded | SessionNotFound>
  readonly delete: (scheduleID: ID, options?: { directory?: string }) => Effect.Effect<void, NotFound>
  /** Manually fire the tick for a schedule (publishes Triggered). */
  readonly tick: (scheduleID: ID) => Effect.Effect<void>
  /** Record that a fire was processed by the runner. */
  readonly recordRun: (
    scheduleID: ID,
    sessionID: SessionID,
    status: RunStatus,
    ranAt: number,
    options?: { directory?: string },
  ) => Effect.Effect<void>
  /** Remove every scheduled message for a session. */
  readonly clear: (sessionID: SessionID, options?: { directory?: string }) => Effect.Effect<void>
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
  | { kind: "recurring"; cron: Cron; sessionID: SessionID; bridge: EffectBridge.Shape; directory?: string }
  | {
      kind: "once"
      timeout: ReturnType<typeof setTimeout>
      sessionID: SessionID
      runAt: number
      bridge: EffectBridge.Shape
      directory?: string
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

function timerBelongsToDirectory(timer: Timer | undefined, directory: string) {
  return timer?.directory !== undefined && path.resolve(timer.directory) === path.resolve(directory)
}

function scheduleLocation(directory: string | undefined) {
  return directory ? { location: new Location.Ref({ directory: AbsolutePath.make(directory) }) } : undefined
}

function stopSessionTimersInDirectory(timers: Map<ID, Timer>, sessionID: SessionID, directory: string) {
  for (const [id, timer] of timers.entries()) {
    if (timer.sessionID !== sessionID) continue
    if (!timerBelongsToDirectory(timer, directory)) continue
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

async function realpathOrResolve(input: string) {
  return fs.realpath(input).catch(() => path.resolve(input))
}

async function isWithinDirectory(parent: string | undefined, child: string | undefined) {
  if (!parent || !child) return false
  const root = await realpathOrResolve(parent)
  const target = await realpathOrResolve(child)
  return target === root || target.startsWith(root + path.sep)
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

    const currentInstance = InstanceRef.pipe(Effect.catchCause(() => Effect.succeed(undefined)))

    const clearRuntimeState = Effect.fn("Schedule.clearRuntimeState")(function* (
      sessionID: SessionID,
      directory?: string,
    ) {
      if (directory) stopSessionTimersInDirectory(timers, sessionID, directory)
      else stopSessionTimers(timers, sessionID)
      const rows = yield* db
        .select({ id: ScheduleTable.id })
        .from(ScheduleTable)
        .where(eq(ScheduleTable.session_id, sessionID))
        .all()
        .pipe(Effect.orDie)
      const hasAlternateFileSession =
        directory !== undefined
          ? yield* Effect.promise(() => findWorkspaceSessionStores(sessionID)).pipe(
              Effect.map((sessions) =>
                sessions.some((session) => path.resolve(session.directory) !== path.resolve(directory)),
              ),
              Effect.catchCause(() => Effect.succeed(false)),
            )
          : false
      const ids = rows
        .map((row) => row.id as ID)
        .filter((id) => {
          if (!directory) return true
          const timer = timers.get(id)
          if (timer) return timerBelongsToDirectory(timer, directory)
          return !hasAlternateFileSession
        })
      if (ids.length === 0) return
      yield* db.delete(ScheduleRunTable).where(inArray(ScheduleRunTable.schedule_id, ids)).run().pipe(Effect.orDie)
      yield* db.delete(ScheduleTable).where(inArray(ScheduleTable.id, ids)).run().pipe(Effect.orDie)
    })

    const unsubscribeDeleted = yield* events.listen((event) => {
      if (event.type !== SessionV1.Event.Deleted.type) return Effect.void
      const data = event.data as typeof SessionV1.Event.Deleted.data.Type
      return clearRuntimeState(data.sessionID, data.info.directory)
    })
    yield* Effect.addFinalizer(() => unsubscribeDeleted)

    const unsubscribeUpdated = yield* events.listen((event) => {
      if (event.type !== SessionV1.Event.Updated.type) return Effect.void
      const data = event.data as typeof SessionV1.Event.Updated.data.Type
      if (data.info.time.archived === undefined) return Effect.void
      return Effect.gen(function* () {
        const stored = yield* Effect.promise(() => readSessionScheduleState(data.info.directory, data.sessionID))
        for (const schedule of stored) {
          yield* appendScheduleSessionEventBestEffort(
            data.sessionID,
            {
              type: "schedule.deleted",
              scheduleID: schedule.id,
              sessionID: data.sessionID,
              reason: "archived",
            },
            data.info.directory,
          )
        }
        yield* clearRuntimeState(data.sessionID, data.info.directory)
        yield* Effect.promise(() => writeSessionScheduleState(data.info.directory, data.sessionID, []))
      })
    })
    yield* Effect.addFinalizer(() => unsubscribeUpdated)

    const recordRun: Interface["recordRun"] = Effect.fn("Schedule.recordRun")(
      function* (scheduleID, sessionID, runStatus, ranAt, options) {
        const restored = yield* ensureScheduleRowFromDirectory(scheduleID, sessionID, options?.directory)
        if (!restored) return
        yield* events.publish(
          Event.Ran,
          { scheduleID, sessionID, status: runStatus, ranAt },
          scheduleLocation(options?.directory),
        )
        const timer = timers.get(scheduleID)
        const nextRun = timer?.kind === "recurring" ? (timer.cron.nextRun()?.getTime() ?? null) : (timer?.runAt ?? null)
        yield* appendScheduleSessionEventBestEffort(
          sessionID,
          {
            type: "schedule.ran",
            scheduleID,
            sessionID,
            status: runStatus,
            ranAt,
            nextRun,
          },
          options?.directory,
        )
        yield* syncScheduleState(sessionID, options?.directory)
      },
    )

    const completeOnce = Effect.fn("Schedule.completeOnce")(function* (
      scheduleID: ID,
      sessionID: SessionID,
      directoryHint?: string,
    ) {
      yield* appendScheduleSessionEventBestEffort(
        sessionID,
        {
          type: "schedule.deleted",
          scheduleID,
          sessionID,
          reason: "completed",
        },
        directoryHint,
      )
      const timer = timers.get(scheduleID)
      if (timer) stopTimer(timer)
      timers.delete(scheduleID)
      yield* db.delete(ScheduleTable).where(eq(ScheduleTable.id, scheduleID)).run().pipe(Effect.orDie)
      yield* events.publish(Event.Deleted, { scheduleID, sessionID }, scheduleLocation(directoryHint))
      yield* syncScheduleState(sessionID, directoryHint)
    })

    const resolveSessionLocation = Effect.fn("Schedule.resolveSessionLocation")(function* (
      sessionID: SessionID,
      fallbackDirectory?: string,
    ) {
      const directory = (yield* currentInstance)?.directory
      const session = yield* resolveFileSession({
        sessionID,
        directory: fallbackDirectory,
        instanceDirectory: directory,
      })
      if (session) {
        return {
          type: "found",
          directory: session.directory,
          archived: session.time.archived !== undefined,
        } satisfies SessionLocation
      }
      return { type: "none" } satisfies SessionLocation
    })

    const sessionDirectory = Effect.fn("Schedule.sessionDirectory")(function* (
      sessionID: SessionID,
      fallbackDirectory?: string,
    ) {
      const location = yield* resolveSessionLocation(sessionID, fallbackDirectory)
      if (location.type === "found") return location.directory
    })

    const sessionArchiveState = Effect.fn("Schedule.sessionArchiveState")(function* (
      sessionID: SessionID,
      fallbackDirectory?: string,
    ) {
      const location = yield* resolveSessionLocation(sessionID, fallbackDirectory)
      if (location.type === "found") return { directory: location.directory, archived: location.archived }
    })

    const activeSchedules = Effect.fn("Schedule.activeSchedules")(function* (
      sessionID: SessionID,
      directoryHint?: string,
    ) {
      const directory = yield* sessionDirectory(sessionID, directoryHint)
      if (!directory) return [] as Info[]
      const projection = yield* Effect.promise(() => readSessionScheduleProjection(directory, sessionID))
      return projection.schedules.map((schedule) => {
        const timer = timers.get(schedule.id as ID)
        const nextRun =
          timer && timerBelongsToDirectory(timer, directory)
            ? timer.kind === "recurring"
              ? (timer.cron.nextRun()?.getTime() ?? null)
              : (timer.runAt ?? null)
            : schedule.nextRun
        return {
          ...schedule,
          id: schedule.id as ID,
          sessionID: schedule.sessionID as SessionID,
          nextRun,
        } satisfies Info
      })
    })

    const syncScheduleState = Effect.fn("Schedule.syncScheduleState")(function* (
      sessionID: SessionID,
      directoryHint?: string,
    ) {
      const directory = yield* sessionDirectory(sessionID, directoryHint)
      if (!directory) return
      const schedules = yield* activeSchedules(sessionID, directory)
      yield* Effect.promise(() => writeSessionScheduleState(directory, sessionID, schedules))
    })

    const appendScheduleSessionEvent = Effect.fn("Schedule.appendScheduleSessionEvent")(function* (
      sessionID: SessionID,
      entry: Record<string, unknown>,
      directoryHint?: string,
    ) {
      const directory = yield* sessionDirectory(sessionID, directoryHint)
      if (!directory) return
      const session = yield* Effect.promise(() => readSessionStore(directory, sessionID))
      if (!session) return
      yield* Effect.promise(() => appendSessionJsonl(session, entry))
      yield* Effect.promise(() => touchSessionStore(directory, sessionID))
    })

    const appendScheduleSessionEventBestEffort = (
      sessionID: SessionID,
      entry: Record<string, unknown>,
      directoryHint?: string,
    ) =>
      appendScheduleSessionEvent(sessionID, entry, directoryHint).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("failed to append schedule event to atree session log", { sessionID, cause }),
        ),
      )

    const ensureScheduleRowFromDirectory = Effect.fn("Schedule.ensureScheduleRowFromDirectory")(function* (
      scheduleID: ID,
      sessionID: SessionID,
      directoryHint?: string,
    ) {
      const existing = yield* db
        .select({ id: ScheduleTable.id, sessionID: ScheduleTable.session_id })
        .from(ScheduleTable)
        .where(eq(ScheduleTable.id, scheduleID))
        .get()
        .pipe(Effect.orDie)
      const directory = yield* sessionDirectory(sessionID, directoryHint)
      if (existing) {
        if (!directoryHint) return true
        if (!directory) return false
        if (timerBelongsToDirectory(timers.get(scheduleID), directory)) return true
        const timer = timers.get(scheduleID)
        if (timer) {
          stopTimer(timer)
          timers.delete(scheduleID)
        }
        yield* db.delete(ScheduleRunTable).where(eq(ScheduleRunTable.schedule_id, scheduleID)).run().pipe(Effect.orDie)
        yield* db.delete(ScheduleTable).where(eq(ScheduleTable.id, scheduleID)).run().pipe(Effect.orDie)
      }

      if (!directory) return false
      const projection = yield* Effect.promise(() => readSessionScheduleProjection(directory, sessionID))
      const schedule = projection.schedules.find((item) => item.id === scheduleID)
      if (!schedule || !canRestoreStoredSchedule(schedule)) return false

      yield* db
        .transaction((tx) =>
          tx
            .insert(ScheduleTable)
            .values({
              id: scheduleID,
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

      startTimer(scheduleID, sessionID, schedule.kind, schedule.expression, schedule.runAt, serviceBridge, directory)
      return true
    })

    const clearArchivedScheduleState = Effect.fn("Schedule.clearArchivedScheduleState")(function* (
      sessionID: SessionID,
      directory: string,
    ) {
      const stored = yield* Effect.promise(() => readSessionScheduleState(directory, sessionID))
      for (const schedule of stored) {
        yield* appendScheduleSessionEventBestEffort(
          sessionID,
          {
            type: "schedule.deleted",
            scheduleID: schedule.id,
            sessionID,
            reason: "archived",
          },
          directory,
        )
      }
      yield* clearRuntimeState(sessionID, directory)
      yield* Effect.promise(() => writeSessionScheduleState(directory, sessionID, []))
    })

    const ensureScheduleStillExists = Effect.fn("Schedule.ensureScheduleStillExists")(function* (
      scheduleID: ID,
      sessionID: SessionID,
      directoryHint?: string,
    ) {
      const location = yield* resolveSessionLocation(sessionID, directoryHint)
      if (location.type !== "found") {
        const timer = timers.get(scheduleID)
        if (timer) {
          stopTimer(timer)
          timers.delete(scheduleID)
        }
        yield* db.delete(ScheduleRunTable).where(eq(ScheduleRunTable.schedule_id, scheduleID)).run().pipe(Effect.orDie)
        yield* db.delete(ScheduleTable).where(eq(ScheduleTable.id, scheduleID)).run().pipe(Effect.orDie)
        return { type: "missing" } as const
      }
      if (location.archived) return { type: "archived", directory: location.directory } as const
      const projection = yield* Effect.promise(() => readSessionScheduleProjection(location.directory, sessionID))
      const schedule = projection.schedules.find((item) => item.id === scheduleID)
      if (!schedule || !canRestoreStoredSchedule(schedule)) {
        const timer = timers.get(scheduleID)
        if (timer) {
          stopTimer(timer)
          timers.delete(scheduleID)
        }
        yield* db.delete(ScheduleRunTable).where(eq(ScheduleRunTable.schedule_id, scheduleID)).run().pipe(Effect.orDie)
        yield* db.delete(ScheduleTable).where(eq(ScheduleTable.id, scheduleID)).run().pipe(Effect.orDie)
        return { type: "stale", directory: location.directory } as const
      }
      const existingRow = yield* db
        .select({ id: ScheduleTable.id, kind: ScheduleTable.kind, expression: ScheduleTable.expression, run_at: ScheduleTable.run_at, message: ScheduleTable.message, created_at: ScheduleTable.created_at })
        .from(ScheduleTable)
        .where(eq(ScheduleTable.id, scheduleID))
        .get()
        .pipe(Effect.orDie)
      const needsRefresh =
        !existingRow ||
        (existingRow.kind ?? "recurring") !== schedule.kind ||
        existingRow.expression !== schedule.expression ||
        (existingRow.run_at ?? null) !== schedule.runAt ||
        existingRow.message !== schedule.message ||
        existingRow.created_at !== schedule.createdAt
      if (needsRefresh) {
        yield* db.delete(ScheduleRunTable).where(eq(ScheduleRunTable.schedule_id, scheduleID)).run().pipe(Effect.orDie)
        yield* db.delete(ScheduleTable).where(eq(ScheduleTable.id, scheduleID)).run().pipe(Effect.orDie)
        yield* db
          .transaction((tx) =>
            tx
              .insert(ScheduleTable)
              .values({
                id: scheduleID,
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
      }
      return { type: "found", directory: location.directory, schedule } as const
    })

    const findStoredScheduleByID = Effect.fn("Schedule.findStoredScheduleByID")(function* (
      scheduleID: ID,
      directoryHint?: string,
    ) {
      if (directoryHint) {
        return yield* Effect.promise(() => findSessionScheduleState(directoryHint, scheduleID)).pipe(
          Effect.catchCause(() => Effect.succeed(undefined)),
        )
      }
      return yield* Effect.promise(() => findWorkspaceSessionScheduleState(scheduleID)).pipe(
        Effect.catchCause(() => Effect.succeed(undefined)),
      )
    })

    const cleanupCompletedOnceForSession = Effect.fn("Schedule.cleanupCompletedOnceForSession")(function* (
      sessionID: SessionID,
      directoryHint?: string,
    ) {
      const directory = yield* sessionDirectory(sessionID, directoryHint)
      if (!directory) return
      const projection = yield* Effect.promise(() => readSessionScheduleProjection(directory, sessionID))
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
        const schedule = projection.schedules.find((item) => item.id === row.id)
        if (schedule?.lastRanAt !== null && schedule?.lastRunStatus !== null) {
          yield* completeOnce(row.id as ID, row.session_id as SessionID, directoryHint)
        }
      }
    })

    const process = Effect.fn("Schedule.process")(function* (scheduleID: ID) {
      const timerDirectory = timers.get(scheduleID)?.directory
      const row = yield* db
        .select()
        .from(ScheduleTable)
        .where(eq(ScheduleTable.id, scheduleID))
        .get()
        .pipe(Effect.orDie)
      const fallback = row ? undefined : yield* findStoredScheduleByID(scheduleID, timerDirectory)
      if (!row && !fallback) return
      const sessionID = row ? (row.session_id as SessionID) : (fallback!.sessionID as SessionID)
      const fallbackSchedule = fallback?.schedules.find((item) => item.id === scheduleID)
      const kind = row ? ((row.kind ?? "recurring") as Kind) : ((fallbackSchedule?.kind ?? "recurring") as Kind)
      const scheduleState = yield* ensureScheduleStillExists(scheduleID, sessionID, timerDirectory)
      if (scheduleState.type === "missing" || scheduleState.type === "stale") return
      const directoryHint = scheduleState.directory
      if (scheduleState.type === "archived") {
        yield* recordRun(scheduleID, sessionID, "skipped", Date.now(), { directory: directoryHint })
        if (kind === "once") {
          yield* completeOnce(scheduleID, sessionID, directoryHint)
        }
        return
      }
      const schedule = scheduleState.schedule
      yield* events.publish(
        Event.Triggered,
        {
          scheduleID,
          sessionID,
          message: schedule.message,
        },
        scheduleLocation(directoryHint),
      )
      const statusService = yield* Effect.serviceOption(SessionStatus.Service)
      const sessionStatus = Option.isSome(statusService)
        ? yield* Effect.gen(function* () {
            const exact = yield* statusService.value.get(sessionID, { directory: directoryHint })
            if (exact.type !== "idle") return exact
            return yield* statusService.value.get(sessionID)
          })
        : { type: "idle" as const }
      const ranAt = Date.now()
      if (sessionStatus.type === "busy") {
        yield* recordRun(scheduleID, sessionID, "skipped", ranAt, { directory: directoryHint })
        if (kind === "once") {
          yield* completeOnce(scheduleID, sessionID, directoryHint)
        }
        return
      }
      const { SessionPrompt } = yield* Effect.promise(() => import("./prompt"))
      const promptService = yield* Effect.serviceOption(SessionPrompt.Service)
      if (Option.isNone(promptService)) {
        yield* recordRun(scheduleID, sessionID, "skipped", ranAt, { directory: directoryHint })
        if (kind === "once") {
          yield* completeOnce(scheduleID, sessionID, directoryHint)
        }
        return
      }
      yield* promptService.value
        .prompt({
          sessionID,
          directory: directoryHint,
          parts: [
            {
              type: "text",
              text: schedule.message,
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
      yield* recordRun(scheduleID, sessionID, "ran", ranAt, { directory: directoryHint })
      if (kind === "once") {
        yield* completeOnce(scheduleID, sessionID, directoryHint)
      }
    })

    function startTimer(
      scheduleID: ID,
      sessionID: SessionID,
      kind: Kind,
      expression: string,
      runAt: number | null,
      bridge: EffectBridge.Shape,
      directory?: string,
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
        timers.set(scheduleID, { kind, timeout, sessionID, runAt, bridge, directory })
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
      timers.set(scheduleID, { kind, cron, sessionID, bridge, directory })
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
      if (!row) {
        const found = yield* Effect.promise(() => findWorkspaceSessionScheduleState(scheduleID)).pipe(
          Effect.catchCause(() => Effect.succeed(undefined)),
        )
        if (!found) return
        const restored = yield* ensureScheduleRowFromDirectory(
          scheduleID,
          found.sessionID as SessionID,
          found.directory,
        )
        if (restored) yield* process(scheduleID)
        return
      }
      const sessionID = row.session_id as SessionID
      const scheduleState = yield* ensureScheduleStillExists(scheduleID, sessionID)
      if (scheduleState.type === "missing" || scheduleState.type === "stale") return
      if (scheduleState.type === "archived") {
        yield* clearArchivedScheduleState(sessionID, scheduleState.directory)
        return
      }
      const schedule = scheduleState.schedule
      yield* events.publish(
        Event.Triggered,
        {
          scheduleID,
          sessionID,
          message: schedule.message,
        },
        scheduleLocation(scheduleState.directory),
      )
    })

    const serviceBridge = yield* EffectBridge.make()
    const restoreStoredSchedules = Effect.fn("Schedule.restoreStoredSchedules")(function* (
      sessionID: SessionID,
      directoryHint?: string,
    ) {
      const archiveState = yield* sessionArchiveState(sessionID, directoryHint)
      if (!archiveState) return [] as Info[]
      if (archiveState.archived) {
        yield* clearArchivedScheduleState(sessionID, archiveState.directory)
        return [] as Info[]
      }
      const directory = archiveState.directory
      yield* sessionDirectory(sessionID, directory)
      const stored = yield* Effect.promise(() => readSessionScheduleState(directory, sessionID))
      if (stored.length === 0) return [] as Info[]

      const existing = yield* db
        .select({ id: ScheduleTable.id })
        .from(ScheduleTable)
        .where(eq(ScheduleTable.session_id, sessionID))
        .all()
        .pipe(Effect.orDie)
      const existingIDs = new Set(existing.map((row) => row.id))
      const sorted = [...stored].sort(
        (a, b) => (a.nextRun ?? Number.MAX_SAFE_INTEGER) - (b.nextRun ?? Number.MAX_SAFE_INTEGER),
      )

      for (const schedule of sorted.slice(0, MAX_PER_SESSION)) {
        if (!canRestoreStoredSchedule(schedule)) continue
        const id = schedule.id as ID
        if (existingIDs.has(schedule.id)) {
          const timer = timers.get(id)
          if (timer && !timerBelongsToDirectory(timer, directory)) {
            continue
          }
          if (timer) {
            stopTimer(timer)
            timers.delete(id)
          }
          yield* db.delete(ScheduleRunTable).where(eq(ScheduleRunTable.schedule_id, id)).run().pipe(Effect.orDie)
          yield* db.delete(ScheduleTable).where(eq(ScheduleTable.id, id)).run().pipe(Effect.orDie)
        }
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
        startTimer(id, sessionID, schedule.kind, schedule.expression, schedule.runAt, serviceBridge, directory)
      }

      const schedules = yield* activeSchedules(sessionID, directory)
      if (schedules.length > 0) yield* syncScheduleState(sessionID, directory)
      return schedules
    })

    const reconcileDirectorySchedules = Effect.fn("Schedule.reconcileDirectorySchedules")(function* (
      sessionID: SessionID,
      directory: string,
      schedules: ReadonlyArray<Info>,
    ) {
      const wantedIDs = new Set(schedules.filter(canRestoreStoredSchedule).map((schedule) => schedule.id))
      const hasAlternateFileSession = yield* Effect.promise(() => findWorkspaceSessionStores(sessionID)).pipe(
        Effect.map((sessions) =>
          sessions.some((session) => path.resolve(session.directory) !== path.resolve(directory)),
        ),
        Effect.catchCause(() => Effect.succeed(false)),
      )
      const rows = yield* db
        .select({ id: ScheduleTable.id })
        .from(ScheduleTable)
        .where(eq(ScheduleTable.session_id, sessionID))
        .all()
        .pipe(Effect.orDie)
      const staleIDs = rows
        .map((row) => row.id as ID)
        .filter((id) => {
          if (wantedIDs.has(id)) return false
          const timer = timers.get(id)
          if (timer) return timerBelongsToDirectory(timer, directory)
          return !hasAlternateFileSession
        })
      if (staleIDs.length > 0) {
        for (const id of staleIDs) {
          const timer = timers.get(id)
          if (timer) {
            stopTimer(timer)
            timers.delete(id)
          }
        }
        yield* db
          .delete(ScheduleRunTable)
          .where(inArray(ScheduleRunTable.schedule_id, staleIDs))
          .run()
          .pipe(Effect.orDie)
        yield* db.delete(ScheduleTable).where(inArray(ScheduleTable.id, staleIDs)).run().pipe(Effect.orDie)
      }
      if (wantedIDs.size === 0) {
        yield* Effect.promise(() => writeSessionScheduleState(directory, sessionID, []))
        return [] as Info[]
      }
      return yield* restoreStoredSchedules(sessionID, directory)
    })

    const restoreFileBackedSchedules = Effect.fn("Schedule.restoreFileBackedSchedules")(function* (directory: string) {
      const fileSessions = yield* Effect.promise(() => readSessionStoresDeep(directory)).pipe(
        Effect.catchCause(() => Effect.succeed([])),
      )
      yield* Effect.forEach(
        fileSessions,
        (session) =>
          restoreStoredSchedules(session.id, session.directory).pipe(
            Effect.catchCause((cause) => Effect.logWarning("failed to restore file-backed schedules", { cause })),
          ),
        { concurrency: "unbounded", discard: true },
      )
    })

    const hydrated = yield* db.select().from(ScheduleTable).all().pipe(Effect.orDie)
    for (const row of hydrated) {
      const id = row.id as ID
      const sessionID = row.session_id as SessionID
      const scheduleState = yield* ensureScheduleStillExists(id, sessionID)
      if (scheduleState.type === "missing" || scheduleState.type === "stale") continue
      if (scheduleState.type === "archived") {
        yield* clearArchivedScheduleState(sessionID, scheduleState.directory)
        continue
      }
      const schedule = scheduleState.schedule
      const kind = schedule.kind
      if (kind === "once") {
        if (schedule.lastRanAt !== null && schedule.lastRunStatus !== null) {
          yield* completeOnce(id, sessionID, scheduleState.directory)
          continue
        }
      }
      startTimer(
        id,
        sessionID,
        kind,
        schedule.expression,
        schedule.runAt,
        serviceBridge,
        scheduleState.directory,
      )
    }
    const rootDirectory = yield* Effect.promise(() => readWorkspaceRootDirectory()).pipe(
      Effect.catchCause(() => Effect.succeed<string | undefined>(undefined)),
    )
    if (rootDirectory) yield* restoreFileBackedSchedules(rootDirectory)

    const restoreDirectory: Interface["restoreDirectory"] = Effect.fn("Schedule.restoreDirectory")(
      function* (directory) {
        yield* restoreFileBackedSchedules(directory)
      },
    )

    const list: Interface["list"] = Effect.fn("Schedule.list")(function* (
      sessionID: SessionID,
      options?: { directory?: string },
    ) {
      const directoryHint = options?.directory
      const location = yield* resolveSessionLocation(sessionID, directoryHint)
      if (location.type !== "found") return [] as Info[]
      if (location.archived) {
        yield* clearArchivedScheduleState(sessionID, location.directory)
        return [] as Info[]
      }
      const directory = location.directory
      const projection = yield* Effect.promise(() => readSessionScheduleProjection(directory, sessionID))
      if (projection.hasState) {
        return yield* reconcileDirectorySchedules(
          sessionID,
          directory,
          projection.schedules.map((schedule) => ({
            ...schedule,
            id: schedule.id as ID,
            sessionID: schedule.sessionID as SessionID,
          })),
        )
      }
      return yield* reconcileDirectorySchedules(sessionID, directory, [])
    })

    const create: Interface["create"] = Effect.fn("Schedule.create")(function* (input: {
      sessionID: SessionID
      kind?: Kind
      expression?: string
      runAt?: number
      message: string
      directory?: string
    }) {
      const kind = input.kind ?? "recurring"
      const expression = kind === "recurring" ? input.expression?.trim() : input.expression?.trim() || ""
      const runAt = kind === "once" ? yield* validateRunAt(input.runAt) : null
      let previewNextRun: number | null = runAt
      if (kind === "recurring") {
        if (!expression) {
          return yield* Effect.fail(new InvalidExpression({ expression: "", reason: "expression is required" }))
        }
        const cron = yield* validateExpression(expression)
        previewNextRun = cron.nextRun()?.getTime() ?? null
      }
      const location = yield* resolveSessionLocation(input.sessionID, input.directory)
      if (location.type !== "found") {
        return yield* Effect.fail(new SessionNotFound({ sessionID: input.sessionID }))
      }
      const directory = location.directory
      const projection = yield* Effect.promise(() => readSessionScheduleProjection(directory, input.sessionID))
      yield* reconcileDirectorySchedules(
        input.sessionID,
        directory,
        projection.hasState
          ? projection.schedules.map((schedule) => ({
              ...schedule,
              id: schedule.id as ID,
              sessionID: schedule.sessionID as SessionID,
            }))
          : [],
      )
      yield* cleanupCompletedOnceForSession(input.sessionID, directory)
      const active = yield* activeSchedules(input.sessionID, directory)
      if (active.length >= MAX_PER_SESSION) {
        return yield* Effect.fail(new LimitExceeded({ sessionID: input.sessionID, limit: MAX_PER_SESSION }))
      }
      const id = Identifier.create("sch", "ascending") as ID
      const createdAt = Date.now()
      const created = {
        id,
        sessionID: input.sessionID,
        kind,
        expression: expression || "",
        runAt,
        message: input.message,
        createdAt,
        lastRanAt: null,
        lastRunStatus: null,
        nextRun: previewNextRun,
      } satisfies Info
      yield* Effect.promise(() =>
        writeSessionScheduleState(directory, input.sessionID, [...active.filter((schedule) => schedule.id !== id), created]),
      ).pipe(Effect.orDie)
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
      startTimer(id, input.sessionID, kind, expression || "", runAt, bridge, directory)
      yield* events.publish(Event.Created, { scheduleID: id, sessionID: input.sessionID }, scheduleLocation(directory))
      yield* syncScheduleState(input.sessionID, input.directory)
      return created
    })

    const clearScheduleProjection = Effect.fn("Schedule.clearScheduleProjection")(function* (
      scheduleID: ID,
      directory?: string,
    ) {
      if (directory) {
        if (!timerBelongsToDirectory(timers.get(scheduleID), directory)) return
      }
      yield* db.delete(ScheduleRunTable).where(eq(ScheduleRunTable.schedule_id, scheduleID)).run().pipe(Effect.orDie)
      yield* db.delete(ScheduleTable).where(eq(ScheduleTable.id, scheduleID)).run().pipe(Effect.orDie)
    })

    const deleteStoredSchedule = Effect.fn("Schedule.deleteStoredSchedule")(function* (
      scheduleID: ID,
      directory: string | undefined,
    ) {
      if (!directory) {
        const found = yield* Effect.promise(() => findWorkspaceSessionScheduleState(scheduleID)).pipe(
          Effect.catchCause(() => Effect.succeed(undefined)),
        )
        if (!found) return false
        const remaining = found.schedules.filter((schedule) => schedule.id !== scheduleID)
        const timer = timers.get(scheduleID)
        if (timer && timerBelongsToDirectory(timer, found.directory)) {
          stopTimer(timer)
          timers.delete(scheduleID)
        }
        yield* events.publish(
          Event.Deleted,
          {
            scheduleID,
            sessionID: found.sessionID as SessionID,
          },
          scheduleLocation(found.directory),
        )
        yield* appendScheduleSessionEventBestEffort(
          found.sessionID as SessionID,
          {
            type: "schedule.deleted",
            scheduleID,
            sessionID: found.sessionID,
            reason: "deleted",
          },
          found.directory,
        )
        yield* Effect.promise(() => writeSessionScheduleState(found.directory, found.sessionID, remaining))
        yield* clearScheduleProjection(scheduleID)
        return true
      }
      const fileSessions = yield* Effect.promise(() => readSessionStoresDeep(directory))
      for (const session of fileSessions) {
        const stored = yield* Effect.promise(() => readSessionScheduleState(session.directory, session.id))
        const remaining = stored.filter((schedule) => schedule.id !== scheduleID)
        if (remaining.length === stored.length) continue
        const timer = timers.get(scheduleID)
        if (timer && timerBelongsToDirectory(timer, session.directory)) {
          stopTimer(timer)
          timers.delete(scheduleID)
        }
        yield* events.publish(
          Event.Deleted,
          {
            scheduleID,
            sessionID: session.id,
          },
          scheduleLocation(session.directory),
        )
        yield* appendScheduleSessionEventBestEffort(
          session.id,
          {
            type: "schedule.deleted",
            scheduleID,
            sessionID: session.id,
            reason: "deleted",
          },
          session.directory,
        )
        yield* Effect.promise(() => writeSessionScheduleState(session.directory, session.id, remaining))
        yield* clearScheduleProjection(scheduleID, session.directory)
        return true
      }
      return false
    })

    const deleteSchedule: Interface["delete"] = Effect.fn("Schedule.delete")(function* (
      scheduleID: ID,
      options?: { directory?: string },
    ) {
      if (options?.directory) {
        const deleted = yield* deleteStoredSchedule(scheduleID, options.directory)
        if (deleted) return
        return yield* Effect.fail(new NotFound({ scheduleID }))
      }
      const deletedStored = yield* deleteStoredSchedule(scheduleID, undefined)
      if (deletedStored) return
      const timer = timers.get(scheduleID)
      const deleted = yield* deleteStoredSchedule(scheduleID, options?.directory ?? timer?.directory)
      if (deleted) return
      return yield* Effect.fail(new NotFound({ scheduleID }))
    })

    const clear: Interface["clear"] = Effect.fn("Schedule.clear")(function* (
      sessionID: SessionID,
      options?: { directory?: string },
    ) {
      const directory = yield* sessionDirectory(sessionID, options?.directory)
      if (options?.directory && !directory) return
      if (!options?.directory && !directory) {
        const matches = yield* Effect.promise(() => findWorkspaceSessionStores(sessionID)).pipe(
          Effect.catchCause(() => Effect.succeed([])),
        )
        if (matches.length > 0) return
      }
      const stored = directory ? yield* Effect.promise(() => readSessionScheduleState(directory, sessionID)) : []
      if (options?.directory && directory) {
        const deletedIDs: ID[] = []
        for (const schedule of stored) {
          yield* appendScheduleSessionEventBestEffort(
            sessionID,
            {
              type: "schedule.deleted",
              scheduleID: schedule.id,
              sessionID,
              reason: "cleared",
            },
            directory,
          )
          const id = schedule.id as ID
          const timer = timers.get(id)
          if (!timerBelongsToDirectory(timer, directory)) continue
          if (timer) {
            stopTimer(timer)
            timers.delete(id)
          }
          deletedIDs.push(id)
        }
        if (deletedIDs.length > 0) {
          yield* db
            .delete(ScheduleRunTable)
            .where(inArray(ScheduleRunTable.schedule_id, deletedIDs))
            .run()
            .pipe(Effect.orDie)
          yield* db.delete(ScheduleTable).where(inArray(ScheduleTable.id, deletedIDs)).run().pipe(Effect.orDie)
          for (const id of deletedIDs) {
            yield* events.publish(Event.Deleted, { scheduleID: id, sessionID }, scheduleLocation(directory))
          }
        }
        yield* Effect.promise(() => writeSessionScheduleState(directory, sessionID, []))
        return
      }
      for (const schedule of stored) {
        yield* appendScheduleSessionEventBestEffort(
          sessionID,
          {
            type: "schedule.deleted",
            scheduleID: schedule.id,
            sessionID,
            reason: "cleared",
          },
          directory,
        )
        const timer = timers.get(schedule.id as ID)
        if (timer) {
          stopTimer(timer)
          timers.delete(schedule.id as ID)
        }
        yield* clearScheduleProjection(schedule.id as ID, directory)
        yield* events.publish(
          Event.Deleted,
          { scheduleID: schedule.id as ID, sessionID },
          scheduleLocation(directory ?? options?.directory ?? timer?.directory),
        )
      }
      if (directory) {
        yield* Effect.promise(() => writeSessionScheduleState(directory, sessionID, []))
        yield* syncScheduleState(sessionID, options?.directory)
      }
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
