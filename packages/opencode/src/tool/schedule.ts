import { Effect, Schema } from "effect"
import { Schedule } from "../session/schedule"
import * as Tool from "./tool"

const DESCRIPTION = `Manage recurring scheduled tasks attached to the current session.

A scheduled task injects a message into this session at a cron-defined cadence. When the cron fires, the message is sent to the session as if the user typed it, and the assistant responds. If the session is currently busy when a fire is due, that tick is skipped (not queued).

Actions:
- create - Add a new scheduled task. Requires "expression" (5-field cron) and "message". Returns the new id and the next planned run.
- delete - Remove a scheduled task. Requires "id" (from create or list).
- list   - Return all scheduled tasks for this session.

Cron expressions are interpreted in the server's local timezone. Use standard 5-field syntax - do NOT pass natural language ("every 10 minutes"); convert to e.g. "*/10 * * * *" yourself.

Examples:
  schedule({ action: "create", expression: "*/10 * * * *", message: "Check the build queue" })
  schedule({ action: "create", expression: "0 9 * * *", message: "Generate the daily summary" })
  schedule({ action: "list" })
  schedule({ action: "delete", id: "sch_..." })

Minimum interval is 60 seconds. Maximum 10 schedules per session.`

export const Parameters = Schema.Struct({
  action: Schema.Literals(["create", "delete", "list"]).annotate({
    description:
      "Which operation to perform. 'create' requires expression+message; 'delete' requires id; 'list' takes no extra fields.",
  }),
  expression: Schema.optional(Schema.String).annotate({
    description:
      "Required for action='create'. Standard 5-field cron expression. Example: '*/10 * * * *'. Minimum interval 60s.",
  }),
  message: Schema.optional(Schema.String).annotate({
    description:
      "Required for action='create'. Message content to inject into the session when the cron fires.",
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

export const ScheduleTool = Tool.define<typeof Parameters, Metadata, Schedule.Service>(
  "schedule",
  Effect.gen(function* () {
    const schedule = yield* Schedule.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          switch (params.action) {
            case "create": {
              if (!params.expression || !params.message) {
                return {
                  title: "Missing fields",
                  output:
                    "action='create' requires both 'expression' (5-field cron) and 'message'. Re-call with both fields.",
                  metadata: { action: "create" } satisfies Metadata,
                }
              }
              const expression = params.expression.trim()
              const message = params.message
              return yield* schedule.create({ sessionID: ctx.sessionID, expression, message }).pipe(
                Effect.map((info) => ({
                  title: `Scheduled: ${expression}`,
                  output: JSON.stringify(
                    {
                      id: info.id,
                      expression: info.expression,
                      message: info.message,
                      nextRun: info.nextRun ? new Date(info.nextRun).toISOString() : null,
                    },
                    null,
                    2,
                  ),
                  metadata: { action: "create" as const, scheduleID: info.id } satisfies Metadata,
                })),
                Effect.catchTag("ScheduleInvalidExpression", (e) =>
                  Effect.succeed({
                    title: "Invalid cron expression",
                    output: `Invalid cron expression "${e.expression}": ${e.reason}. Use a standard 5-field cron expression like "*/10 * * * *" (every 10 minutes) or "0 9 * * *" (daily at 9 AM). Do not pass natural language.`,
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
                    title: "Too many schedules",
                    output: `This session already has ${e.limit} scheduled tasks (the maximum). Delete one with schedule({action:"delete",id:"..."}) before adding another.`,
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
              return yield* schedule.delete(id as Schedule.ID).pipe(
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
              const items = yield* schedule.list(ctx.sessionID)
              const payload = items.map((info) => ({
                id: info.id,
                expression: info.expression,
                message: info.message,
                nextRun: info.nextRun ? new Date(info.nextRun).toISOString() : null,
                lastRanAt: info.lastRanAt ? new Date(info.lastRanAt).toISOString() : null,
                lastRunStatus: info.lastRunStatus,
              }))
              return {
                title: items.length === 0 ? "No schedules" : `${items.length} schedule${items.length === 1 ? "" : "s"}`,
                output: JSON.stringify(payload, null, 2),
                metadata: { action: "list", count: items.length } satisfies Metadata,
              }
            }
          }
        }),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)
