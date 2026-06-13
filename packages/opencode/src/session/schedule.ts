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
  | { kind: "once"; timeout: ReturnType<typeof setTimeout>; sessionID: SessionID; runAt: number; bridge: EffectBridge.Shape }

function stopTimer(timer: Timer) {
  if (timer.kind === "recurring") timer.cron.stop()
  else clearTimeout(timer.timeout)
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
      },
    )

    const process = Effect.fn("Schedule.process")(function* (scheduleID: ID) {
      const row = yield* db.select().from(ScheduleTable).where(eq(ScheduleTable.id, scheduleID)).get().pipe(Effect.orDie)
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
          const timer = timers.get(scheduleID)
          if (timer) stopTimer(timer)
          timers.delete(scheduleID)
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
        const timer = timers.get(scheduleID)
        if (timer) stopTimer(timer)
        timers.delete(scheduleID)
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
        const timeout = setTimeout(() => {
          bridge.promise(process(scheduleID)).catch((e) =>
            console.error("schedule timer error", {
              scheduleID,
              error: e instanceof Error ? e.message : String(e),
            }),
          )
        }, Math.max(0, runAt - Date.now()))
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
      const row = yield* db.select().from(ScheduleTable).where(eq(ScheduleTable.id, scheduleID)).get().pipe(Effect.orDie)
      if (!row) return
      yield* events.publish(Event.Triggered, {
        scheduleID,
        sessionID: row.session_id as SessionID,
        message: row.message,
      })
    })

    const serviceBridge = yield* EffectBridge.make()
    const hydrated = yield* db.select().from(ScheduleTable).all().pipe(Effect.orDie)
    for (const row of hydrated) {
      const id = row.id as ID
      const kind = (row.kind ?? "recurring") as Kind
      if (kind === "once") {
        const lastRun = yield* db
          .select({ ran_at: ScheduleRunTable.ran_at })
          .from(ScheduleRunTable)
          .where(eq(ScheduleRunTable.schedule_id, id))
          .limit(1)
          .get()
          .pipe(Effect.orDie)
        if (lastRun) continue
      }
      startTimer(id, row.session_id as SessionID, kind, row.expression, row.run_at ?? null, serviceBridge)
    }

    const list: Interface["list"] = Effect.fn("Schedule.list")(function* (sessionID: SessionID) {
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
            const lastRun = yield* db
              .select({
                ran_at: ScheduleRunTable.ran_at,
                status: ScheduleRunTable.status,
              })
              .from(ScheduleRunTable)
              .where(eq(ScheduleRunTable.schedule_id, row.id))
              .orderBy(desc(ScheduleRunTable.ran_at))
              .limit(1)
              .get()
              .pipe(Effect.orDie)
        const timer = timers.get(row.id as ID)
        const nextRun = timer?.kind === "recurring" ? timer.cron.nextRun()?.getTime() ?? null : timer?.runAt ?? null
        return {
          id: row.id as ID,
          sessionID: row.session_id as SessionID,
          kind: (row.kind ?? "recurring") as Kind,
          expression: row.expression,
          runAt: row.run_at ?? null,
          message: row.message,
          createdAt: row.created_at,
          lastRanAt: lastRun?.ran_at ?? null,
          lastRunStatus: (lastRun?.status as RunStatus | undefined) ?? null,
          nextRun,
        }
          }),
        ),
      )
    })

    const create: Interface["create"] = Effect.fn("Schedule.create")(function* (input: {
      sessionID: SessionID
      kind?: Kind
      expression?: string
      runAt?: number
      message: string
    }) {
      const kind = input.kind ?? "recurring"
      const expression = kind === "recurring" ? input.expression?.trim() : (input.expression?.trim() || "")
      const runAt = kind === "once" ? yield* validateRunAt(input.runAt) : null
      if (kind === "recurring") {
        if (!expression) {
          return yield* Effect.fail(new InvalidExpression({ expression: "", reason: "expression is required" }))
        }
        yield* validateExpression(expression)
      }
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
              ? createdTimer.cron.nextRun()?.getTime() ?? null
              : null,
      } satisfies Info
    })

    const deleteSchedule: Interface["delete"] = Effect.fn("Schedule.delete")(function* (scheduleID: ID) {
      const row = yield* db.select().from(ScheduleTable).where(eq(ScheduleTable.id, scheduleID)).get().pipe(Effect.orDie)
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
    })

    return Service.of({
      list,
      create,
      delete: deleteSchedule,
      tick,
      recordRun,
    })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Database.defaultLayer),
  Layer.provide(EventV2Bridge.defaultLayer),
)

export const node = LayerNode.make(layer, [Database.node, EventV2Bridge.node])

export * as Schedule from "./schedule"
