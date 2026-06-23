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
import { desc, eq, inArray, sql as drizzleSql } from "drizzle-orm"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Location } from "@opencode-ai/core/location"
import { SessionID } from "./schema"
import { ScheduleRunTable, ScheduleTable } from "./schedule.sql"
import { SessionStatus } from "./status"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import {
  findSessionScheduleState,
  readSessionScheduleProjection,
  readSessionScheduleState,
  writeSessionScheduleState,
} from "@/atree/schedule-store"
import {
  appendSessionJsonl,
  findSessionStore,
  readSessionStore,
  readSessionStores,
  readSessionStoresDeep,
  touchSessionStore,
} from "@/atree/session-store"
import { resolveFileSession } from "@/atree/session-resolver"
import { readWorkspaceState } from "@/atree/state"
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
      const sessionRow = directory
        ? yield* db
            .select({ directory: SessionTable.directory })
            .from(SessionTable)
            .where(eq(SessionTable.id, sessionID))
            .get()
            .pipe(Effect.orDie)
        : undefined
      const cacheBelongsToDirectory =
        directory !== undefined &&
        sessionRow?.directory !== undefined &&
        path.resolve(sessionRow.directory) === path.resolve(directory)
      const alternateFileSession =
        directory !== undefined
          ? yield* Effect.promise(() => readWorkspaceState())
              .pipe(
                Effect.flatMap((state) =>
                  state.rootDirectory
                    ? Effect.promise(() => findSessionStore(state.rootDirectory!, sessionID))
                    : Effect.succeed(undefined),
                ),
                Effect.catchCause(() => Effect.succeed(undefined)),
              )
          : undefined
      const hasAlternateFileSession =
        directory !== undefined &&
        alternateFileSession?.directory !== undefined &&
        path.resolve(alternateFileSession.directory) !== path.resolve(directory)
      const ids = rows
        .map((row) => row.id as ID)
        .filter((id) => {
          if (!directory) return true
          const timer = timers.get(id)
          if (timer) return timerBelongsToDirectory(timer, directory)
          return cacheBelongsToDirectory && !hasAlternateFileSession
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

    const restoreStoredRun = Effect.fn("Schedule.restoreStoredRun")(function* (schedule: {
      id: string
      lastRanAt: number | null
      lastRunStatus: RunStatus | null
    }) {
      if (schedule.lastRanAt === null || schedule.lastRunStatus === null) return
      const scheduleID = schedule.id as ID
      const existing = yield* getLastRun(scheduleID)
      if (existing && existing.ran_at >= schedule.lastRanAt) return
      yield* db
        .transaction((tx) =>
          tx
            .insert(ScheduleRunTable)
            .values({
              id: Identifier.create("shr", "ascending"),
              schedule_id: scheduleID,
              ran_at: schedule.lastRanAt,
              status: schedule.lastRunStatus,
            } as typeof ScheduleRunTable.$inferInsert)
            .run(),
        )
        .pipe(Effect.orDie)
    })

    const ensureFileSessionProject = Effect.fn("Schedule.ensureFileSessionProject")(function* (session: FileSession) {
      const existing = yield* db
        .select({ id: ProjectTable.id })
        .from(ProjectTable)
        .where(eq(ProjectTable.id, session.projectID))
        .get()
        .pipe(Effect.orDie)
      if (existing) return
      const now = Date.now()
      yield* db
        .insert(ProjectTable)
        .values({
          id: session.projectID,
          worktree: AbsolutePath.make(session.directory),
          vcs: null,
          name: null,
          time_created: now,
          time_updated: now,
          sandboxes: [],
        } as typeof ProjectTable.$inferInsert)
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
    })

    const upsertFileSessionCache = Effect.fn("Schedule.upsertFileSessionCache")(function* (session: FileSession) {
      const ctx = yield* currentInstance
      const tokens = session.tokens ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
      const projectID = ctx?.project.id ?? session.projectID
      yield* ensureFileSessionProject({ ...session, projectID })
      const row = {
        id: session.id,
        project_id: projectID,
        workspace_id: session.workspaceID ?? null,
        parent_id: session.parentID ?? null,
        slug: session.slug,
        directory: session.directory,
        path: session.path ?? null,
        title: session.title,
        agent: session.agent ?? null,
        model: session.model ?? null,
        version: session.version,
        share_url: null,
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

    const resolveSessionLocation = Effect.fn("Schedule.resolveSessionLocation")(function* (
      sessionID: SessionID,
      fallbackDirectory?: string,
    ) {
      const directory = (yield* currentInstance)?.directory
      const session = yield* resolveFileSession(db, {
        sessionID,
        directory: fallbackDirectory,
        instanceDirectory: directory,
      })
      if (session) {
        yield* upsertFileSessionCache(session)
        return {
          type: "found",
          directory: session.directory,
          archived: session.time.archived !== undefined,
        } satisfies SessionLocation
      }
      if (!fallbackDirectory) {
        const row = yield* db
          .select({ directory: SessionTable.directory, archived: SessionTable.time_archived })
          .from(SessionTable)
          .where(eq(SessionTable.id, sessionID))
          .get()
          .pipe(Effect.orDie)
        const state = yield* Effect.promise(() => readWorkspaceState()).pipe(
          Effect.catchCause(() => Effect.succeed({ rootDirectory: null })),
        )
        if (yield* Effect.promise(() => isWithinDirectory(state.rootDirectory ?? undefined, row?.directory))) {
          return { type: "missing" } satisfies SessionLocation
        }
        if (row?.directory) {
          return {
            type: "found",
            directory: row.directory,
            archived: row.archived !== null,
          } satisfies SessionLocation
        }
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

    const syncScheduleState = Effect.fn("Schedule.syncScheduleState")(function* (
      sessionID: SessionID,
      directoryHint?: string,
    ) {
      const directory = yield* sessionDirectory(sessionID, directoryHint)
      if (!directory) return
      const schedules = yield* activeSchedules(sessionID)
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
      const existingSessionDirectory =
        existing && directoryHint
          ? yield* db
              .select({ directory: SessionTable.directory })
              .from(SessionTable)
              .where(eq(SessionTable.id, existing.sessionID))
              .get()
              .pipe(Effect.orDie)
          : undefined
      const directory = yield* sessionDirectory(sessionID, directoryHint)
      if (existing) {
        if (!directoryHint) return true
        if (!directory) return false
        if (
          timerBelongsToDirectory(timers.get(scheduleID), directory) ||
          (existingSessionDirectory?.directory !== undefined &&
            path.resolve(existingSessionDirectory.directory) === path.resolve(directory))
        ) {
          return true
        }
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

    const cleanupCompletedOnceForSession = Effect.fn("Schedule.cleanupCompletedOnceForSession")(function* (
      sessionID: SessionID,
      directoryHint?: string,
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
          yield* completeOnce(row.id as ID, row.session_id as SessionID, directoryHint)
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
      const timerDirectory = timers.get(scheduleID)?.directory
      const location = yield* resolveSessionLocation(sessionID, timerDirectory)
      if (location.type === "missing") {
        const timer = timers.get(scheduleID)
        if (timer) {
          stopTimer(timer)
          timers.delete(scheduleID)
        }
        return
      }
      const directoryHint = location.type === "found" ? location.directory : timerDirectory
      if (location.type === "found" && location.archived) {
        yield* recordRun(scheduleID, sessionID, "skipped", Date.now(), { directory: directoryHint })
        if (kind === "once") {
          yield* completeOnce(scheduleID, sessionID, directoryHint)
        }
        return
      }
      yield* events.publish(
        Event.Triggered,
        {
          scheduleID,
          sessionID,
          message,
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
        const state = yield* Effect.promise(() => readWorkspaceState()).pipe(
          Effect.catchCause(() => Effect.succeed({ rootDirectory: null })),
        )
        const found = state.rootDirectory
          ? yield* Effect.promise(() => findSessionScheduleState(state.rootDirectory!, scheduleID)).pipe(
              Effect.catchCause(() => Effect.succeed(undefined)),
            )
          : undefined
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
      const location = yield* resolveSessionLocation(sessionID)
      if (location.type === "missing") return
      if (location.type === "found" && location.archived) {
        yield* clearArchivedScheduleState(sessionID, location.directory)
        return
      }
      yield* events.publish(
        Event.Triggered,
        {
          scheduleID,
          sessionID,
          message: row.message,
        },
        scheduleLocation(location.type === "found" ? location.directory : undefined),
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
        yield* restoreStoredRun(schedule)
      }

      const schedules = yield* activeSchedules(sessionID)
      if (schedules.length > 0) yield* syncScheduleState(sessionID, directory)
      return schedules
    })

    const reconcileDirectorySchedules = Effect.fn("Schedule.reconcileDirectorySchedules")(function* (
      sessionID: SessionID,
      directory: string,
      schedules: ReadonlyArray<Info>,
    ) {
      const wantedIDs = new Set(schedules.filter(canRestoreStoredSchedule).map((schedule) => schedule.id))
      const sessionRow = yield* db
        .select({ directory: SessionTable.directory })
        .from(SessionTable)
        .where(eq(SessionTable.id, sessionID))
        .get()
        .pipe(Effect.orDie)
      const cacheBelongsToDirectory =
        sessionRow?.directory !== undefined && path.resolve(sessionRow.directory) === path.resolve(directory)
      const rows = yield* db
        .select({ id: ScheduleTable.id })
        .from(ScheduleTable)
        .where(eq(ScheduleTable.session_id, sessionID))
        .all()
        .pipe(Effect.orDie)
      const staleIDs = rows
        .map((row) => row.id as ID)
        .filter(
          (id) => !wantedIDs.has(id) && (cacheBelongsToDirectory || timerBelongsToDirectory(timers.get(id), directory)),
        )
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
      const location = yield* resolveSessionLocation(sessionID)
      if (location.type === "missing") continue
      if (location.type === "found" && location.archived) {
        yield* clearArchivedScheduleState(sessionID, location.directory)
        continue
      }
      const kind = (row.kind ?? "recurring") as Kind
      if (kind === "once") {
        const lastRun = yield* getLastRun(id)
        if (lastRun) {
          yield* completeOnce(id, sessionID, location.type === "found" ? location.directory : undefined)
          continue
        }
      }
      startTimer(
        id,
        sessionID,
        kind,
        row.expression,
        row.run_at ?? null,
        serviceBridge,
        location.type === "found" ? location.directory : undefined,
      )
    }
    const sessions = yield* db.select({ id: SessionTable.id }).from(SessionTable).all().pipe(Effect.orDie)
    for (const session of sessions) {
      yield* restoreStoredSchedules(session.id as SessionID)
    }
    const rootDirectory = yield* Effect.promise(() => readWorkspaceState()).pipe(
      Effect.map((state) => state.rootDirectory),
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
      if (location.type === "missing") return [] as Info[]
      if (location.type === "found" && location.archived) {
        yield* clearArchivedScheduleState(sessionID, location.directory)
        return [] as Info[]
      }
      const directory = location.type === "found" ? location.directory : undefined
      if (directory) {
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
      }
      if (directoryHint && !directory) return [] as Info[]
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
          yield* completeOnce(row.id as ID, row.session_id as SessionID, directoryHint)
        }
      }
      const items = yield* activeSchedules(sessionID)
      if (items.length > 0 || rows.length > 0) {
        yield* syncScheduleState(sessionID, directoryHint)
        return items
      }
      if (!directory) return items
      const restored = yield* restoreStoredSchedules(sessionID, directory)
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
      directory?: string
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
      const location = yield* resolveSessionLocation(input.sessionID, input.directory)
      if (location.type === "missing") {
        return yield* Effect.fail(new SessionNotFound({ sessionID: input.sessionID }))
      }
      const directory = location.type === "found" ? location.directory : undefined
      if (input.directory && !directory) {
        return yield* Effect.fail(new SessionNotFound({ sessionID: input.sessionID }))
      }
      if (directory) {
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
      } else {
        yield* restoreStoredSchedules(input.sessionID, directory)
      }
      yield* cleanupCompletedOnceForSession(input.sessionID, directory)
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
      startTimer(id, input.sessionID, kind, expression || "", runAt, bridge, directory)
      yield* events.publish(Event.Created, { scheduleID: id, sessionID: input.sessionID }, scheduleLocation(directory))
      const createdTimer = timers.get(id)
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
        nextRun:
          kind === "once"
            ? runAt
            : createdTimer?.kind === "recurring"
              ? (createdTimer.cron.nextRun()?.getTime() ?? null)
              : null,
      } satisfies Info
      yield* appendScheduleSessionEventBestEffort(
        input.sessionID,
        {
          type: "schedule.created",
          schedule: created,
        },
        input.directory,
      )
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
        const state = yield* Effect.promise(() => readWorkspaceState()).pipe(
          Effect.catchCause(() => Effect.succeed({ rootDirectory: null })),
        )
        if (!state.rootDirectory) return false
        const found = yield* Effect.promise(() => findSessionScheduleState(state.rootDirectory!, scheduleID))
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
      const fileSessions = yield* Effect.promise(() => readSessionStores(directory))
      for (const session of fileSessions) {
        const stored = yield* Effect.promise(() => readSessionScheduleState(directory, session.id))
        const remaining = stored.filter((schedule) => schedule.id !== scheduleID)
        if (remaining.length === stored.length) continue
        const timer = timers.get(scheduleID)
        if (timer && timerBelongsToDirectory(timer, directory)) {
          stopTimer(timer)
          timers.delete(scheduleID)
        }
        yield* events.publish(
          Event.Deleted,
          {
            scheduleID,
            sessionID: session.id,
          },
          scheduleLocation(directory),
        )
        yield* appendScheduleSessionEventBestEffort(
          session.id,
          {
            type: "schedule.deleted",
            scheduleID,
            sessionID: session.id,
            reason: "deleted",
          },
          directory,
        )
        yield* Effect.promise(() => writeSessionScheduleState(directory, session.id, remaining))
        yield* clearScheduleProjection(scheduleID, directory)
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
      const row = yield* db
        .select()
        .from(ScheduleTable)
        .where(eq(ScheduleTable.id, scheduleID))
        .get()
        .pipe(Effect.orDie)
      if (!row) {
        const timer = timers.get(scheduleID)
        const deleted = yield* deleteStoredSchedule(scheduleID, options?.directory ?? timer?.directory)
        if (deleted) return
        return yield* Effect.fail(new NotFound({ scheduleID }))
      }
      yield* appendScheduleSessionEventBestEffort(
        row.session_id as SessionID,
        {
          type: "schedule.deleted",
          scheduleID,
          sessionID: row.session_id,
          reason: "deleted",
        },
        options?.directory,
      )
      yield* db.delete(ScheduleTable).where(eq(ScheduleTable.id, scheduleID)).run().pipe(Effect.orDie)
      const timer = timers.get(scheduleID)
      if (timer) {
        stopTimer(timer)
        timers.delete(scheduleID)
      }
      yield* events.publish(
        Event.Deleted,
        {
          scheduleID,
          sessionID: row.session_id as SessionID,
        },
        scheduleLocation(options?.directory ?? timer?.directory),
      )
      yield* syncScheduleState(row.session_id as SessionID, options?.directory)
    })

    const clear: Interface["clear"] = Effect.fn("Schedule.clear")(function* (
      sessionID: SessionID,
      options?: { directory?: string },
    ) {
      const directory = yield* sessionDirectory(sessionID, options?.directory)
      if (options?.directory && !directory) return
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
      const rows = yield* db
        .select({ id: ScheduleTable.id })
        .from(ScheduleTable)
        .where(eq(ScheduleTable.session_id, sessionID))
        .all()
        .pipe(Effect.orDie)
      const rowIDs = new Set(rows.map((row) => row.id))
      for (const row of rows) {
        const id = row.id as ID
        yield* appendScheduleSessionEventBestEffort(
          sessionID,
          {
            type: "schedule.deleted",
            scheduleID: id,
            sessionID,
            reason: "cleared",
          },
          options?.directory,
        )
      }
      for (const schedule of stored) {
        if (rowIDs.has(schedule.id)) continue
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
      }
      stopSessionTimers(timers, sessionID)
      if (rows.length > 0) {
        yield* db.delete(ScheduleTable).where(eq(ScheduleTable.session_id, sessionID)).run().pipe(Effect.orDie)
      }
      for (const row of rows) {
        yield* events.publish(
          Event.Deleted,
          { scheduleID: row.id as ID, sessionID },
          scheduleLocation(directory ?? options?.directory),
        )
      }
      yield* syncScheduleState(sessionID, options?.directory)
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
