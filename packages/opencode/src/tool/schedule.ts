import { Effect, Schema } from "effect"
import { Session } from "@/session/session"
import { Schedule } from "../session/schedule"
import { buildScheduleCreateInput } from "../session/schedule-input"
import * as Tool from "./tool"

const DESCRIPTION = `Manage scheduled tasks attached to the current session.

A scheduled task injects a message into this session automatically. It can be recurring (type="cron") or one-time (type="at"). When it fires, the message is sent to the session as if the user typed it, and the assistant responds. If the session is currently busy when a fire is due, that tick is skipped (not queued).

Actions:
- create - Add a scheduled task. For recurring tasks, pass type="cron", cron (5-field cron), and message. For one-time tasks, pass type="at", at (ISO datetime string or millisecond timestamp), and message.
- delete - Remove a scheduled task. Requires "id" (from create or list).
- list   - Return all scheduled tasks for this session.

Cron expressions are interpreted in the server's local timezone. Use standard 5-field syntax - do NOT pass natural language ("every 10 minutes"); convert to e.g. "*/10 * * * *" yourself.
One-time at values can be ISO datetime strings or Unix millisecond timestamps in the future.

Examples:
  schedule({ action: "create", type: "cron", cron: "*/10 * * * *", message: "Check the build queue" })
  schedule({ action: "create", type: "cron", cron: "0 9 * * *", message: "Generate the daily summary" })
  schedule({ action: "create", type: "at", at: "2026-06-15T09:00:00+08:00", message: "Remind me to review this" })
  schedule({ action: "list" })
  schedule({ action: "delete", id: "sch_..." })

Minimum interval is 60 seconds. Maximum 1 schedule per session. Delete the existing schedule before creating a new one.`

const AtValue = Schema.Union([Schema.Number, Schema.String])

export const Parameters = Schema.Struct({
  action: Schema.Literals(["create", "delete", "list"]).annotate({
    description:
      "Which operation to perform. 'create' requires type+message; 'delete' requires id; 'list' takes no extra fields.",
  }),
  type: Schema.optional(Schema.Literals(["cron", "at"])).annotate({
    description: "Schedule type for action='create'. Use 'cron' for recurring tasks or 'at' for one-time tasks.",
  }),
  cron: Schema.optional(Schema.String).annotate({
    description:
      "Required for action='create' when type is 'cron' or omitted. Standard 5-field cron expression. Example: '*/10 * * * *'. Minimum interval 60s.",
  }),
  at: Schema.optional(AtValue).annotate({
    description:
      "Required for action='create' when type is 'at'. ISO datetime string or Unix millisecond timestamp in the future.",
  }),
  message: Schema.optional(Schema.String).annotate({
    description: "Required for action='create'. Message content to inject into the session when the schedule fires.",
  }),
  id: Schema.optional(Schema.String).annotate({
    description: "Required for action='delete'. Schedule id from create or list.",
  }),
})

type Metadata = {
  action?: "create" | "delete" | "list"
  scheduleID?: string
  count?: number
}

function serialize(info: Schedule.Info) {
  const type = info.kind === "once" ? "at" : "cron"
  return {
    id: info.id,
    type,
    cron: type === "cron" ? info.expression : null,
    at: info.runAt ? new Date(info.runAt).toISOString() : null,
    kind: info.kind,
    expression: info.expression,
    runAt: info.runAt ? new Date(info.runAt).toISOString() : null,
    message: info.message,
    nextRun: info.nextRun ? new Date(info.nextRun).toISOString() : null,
    lastRanAt: info.lastRanAt ? new Date(info.lastRanAt).toISOString() : null,
    lastRunStatus: info.lastRunStatus,
  }
}

export const ScheduleTool = Tool.define<typeof Parameters, Metadata, Schedule.Service | Session.Service>(
  "schedule",
  Effect.gen(function* () {
    const schedule = yield* Schedule.Service
    const session = yield* Session.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const info = yield* session.get(ctx.sessionID, { directory: ctx.directory })
          const directory = info.directory
          switch (params.action) {
            case "create": {
              const resolved = buildScheduleCreateInput(params)
              const type = resolved.kind === "once" ? "at" : "cron"
              const expression = resolved.expression?.trim()
              const runAt = resolved.runAt
              if (!params.message || (type === "cron" && !expression) || (type === "at" && runAt === undefined)) {
                return {
                  title: "Missing fields",
                  output:
                    "action='create' requires message plus either type='cron' with cron or type='at' with at. Re-call with the required fields.",
                  metadata: { action: "create" } satisfies Metadata,
                }
              }
              const message = params.message
              return yield* schedule
                .create({ sessionID: ctx.sessionID, kind: resolved.kind, expression, runAt, message, directory })
                .pipe(
                  Effect.map((info) => ({
                    title: info.kind === "once" ? "Scheduled at" : `Scheduled: ${info.expression}`,
                    output: JSON.stringify(serialize(info), null, 2),
                    metadata: { action: "create" as const, scheduleID: info.id } satisfies Metadata,
                  })),
                  Effect.catchTag("ScheduleInvalidExpression", (e) =>
                    Effect.succeed({
                      title: "Invalid cron expression",
                      output: `Invalid cron expression "${e.expression}": ${e.reason}. Use a standard 5-field cron expression like "*/10 * * * *" (every 10 minutes) or "0 9 * * *" (daily at 9 AM). Do not pass natural language.`,
                      metadata: { action: "create" } satisfies Metadata,
                    }),
                  ),
                  Effect.catchTag("ScheduleInvalidRunAt", (e) =>
                    Effect.succeed({
                      title: "Invalid at",
                      output: `Invalid one-time at value "${e.runAt}": ${e.reason}. Use an ISO datetime string or Unix millisecond timestamp in the future.`,
                      metadata: { action: "create" } satisfies Metadata,
                    }),
                  ),
                  Effect.catchTag("ScheduleIntervalTooShort", (e) =>
                    Effect.succeed({
                      title: "Interval too short",
                      output: `Cron expression "${e.expression}" fires every ${Math.round(e.intervalMs / 1000)} seconds. Minimum is 60 seconds. Pick a longer cadence.`,
                      metadata: { action: "create" } satisfies Metadata,
                    }),
                  ),
                  Effect.catchTag("ScheduleLimitExceeded", (e) =>
                    Effect.succeed({
                      title: "Schedule already exists",
                      output: `This session already has an automation message. Use schedule({action:"list"}) to find it, then schedule({action:"delete",id:"..."}) before creating a new one.`,
                      metadata: { action: "create" } satisfies Metadata,
                    }),
                  ),
                  Effect.catchTag("ScheduleSessionNotFound", (e) =>
                    Effect.succeed({
                      title: "Session not found",
                      output: `Cannot create an automation message because session "${e.sessionID}" is not present in this directory.`,
                      metadata: { action: "create" } satisfies Metadata,
                    }),
                  ),
                )
            }
            case "delete": {
              const id = params.id
              if (!id) {
                return {
                  title: "Missing id",
                  output: "action='delete' requires 'id'. Use schedule({action:'list'}) to find current ids.",
                  metadata: { action: "delete" as const } satisfies Metadata,
                }
              }
              return yield* schedule.delete(id as Schedule.ID, { directory }).pipe(
                Effect.map(() => ({
                  title: "Schedule deleted",
                  output: `Deleted schedule ${id}.`,
                  metadata: { action: "delete" as const, scheduleID: id } satisfies Metadata,
                })),
                Effect.catchTag("ScheduleNotFound", (e) =>
                  Effect.succeed({
                    title: "Schedule not found",
                    output: `No schedule with id "${e.scheduleID}". Use schedule({action:"list"}) to see current ids.`,
                    metadata: { action: "delete" as const } satisfies Metadata,
                  }),
                ),
              )
            }
            case "list": {
              const items = yield* schedule.list(ctx.sessionID, { directory })
              const payload = items.map(serialize)
              return {
                title: items.length === 0 ? "No schedules" : `${items.length} schedule${items.length === 1 ? "" : "s"}`,
                output: JSON.stringify(payload, null, 2),
                metadata: { action: "list", count: items.length } satisfies Metadata,
              }
            }
          }
        }).pipe(Effect.orDie),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)
