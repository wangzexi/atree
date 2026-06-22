export * as SessionTodo from "./todo"

import { asc, eq } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { appendSessionJsonl, findSessionStore, readSessionStore, readWorkspaceRoot } from "../atree/session-store"
import { readSessionTodoProjection, writeSessionTodoState } from "../atree/todo-store"
import { Database } from "../database/database"
import { EventV2 } from "../event"
import { SessionSchema } from "./schema"
import { SessionTable, TodoTable } from "./sql"

export const Info = Schema.Struct({
  content: Schema.String.annotate({ description: "Brief description of the task" }),
  status: Schema.String.annotate({
    description: "Current status of the task: pending, in_progress, completed, cancelled",
  }),
  priority: Schema.String.annotate({ description: "Priority level of the task: high, medium, low" }),
}).annotate({ identifier: "SessionTodo.Info" })
export type Info = typeof Info.Type

export const Event = {
  Updated: EventV2.define({
    type: "todo.updated",
    schema: {
      sessionID: SessionSchema.ID,
      todos: Schema.Array(Info),
    },
  }),
}

export interface Interface {
  readonly update: (input: {
    readonly sessionID: SessionSchema.ID
    readonly todos: ReadonlyArray<Info>
  }) => Effect.Effect<void>
  readonly get: (sessionID: SessionSchema.ID) => Effect.Effect<ReadonlyArray<Info>>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/SessionTodo") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const events = yield* EventV2.Service

    const fileSession = Effect.fn("SessionTodo.fileSession")(function* (sessionID: SessionSchema.ID) {
      const root = yield* Effect.promise(() => readWorkspaceRoot()).pipe(
        Effect.catchCause(() => Effect.succeed<string | undefined>(undefined)),
      )
      if (root) {
        const session = yield* Effect.promise(() => findSessionStore(root, sessionID)).pipe(
          Effect.catchCause(() => Effect.succeed(undefined)),
        )
        if (session) return session
      }
      const row = yield* db
        .select({ directory: SessionTable.directory })
        .from(SessionTable)
        .where(eq(SessionTable.id, sessionID))
        .get()
        .pipe(Effect.orDie)
      if (row?.directory) {
        const session = yield* Effect.promise(() => readSessionStore(row.directory, sessionID)).pipe(
          Effect.catchCause(() => Effect.succeed(undefined)),
        )
        if (session) return session
      }
    })

    const update = Effect.fn("SessionTodo.update")(function* (input: {
      readonly sessionID: SessionSchema.ID
      readonly todos: ReadonlyArray<Info>
    }) {
      const session = yield* fileSession(input.sessionID)
      if (session) {
        yield* Effect.promise(() =>
          appendSessionJsonl(session, {
            type: "todo.updated",
            sessionID: input.sessionID,
            todos: input.todos,
          }),
        ).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("failed to append todo event to atree session log", {
              sessionID: input.sessionID,
              cause,
            }),
          ),
        )
      }
      const row = yield* db
        .select({ id: SessionTable.id })
        .from(SessionTable)
        .where(eq(SessionTable.id, input.sessionID))
        .get()
        .pipe(Effect.orDie)
      if (row || !session) {
        yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              yield* tx.delete(TodoTable).where(eq(TodoTable.session_id, input.sessionID)).run()
              if (input.todos.length === 0) return
              yield* tx
                .insert(TodoTable)
                .values(
                  input.todos.map((todo, position) => ({
                    session_id: input.sessionID,
                    content: todo.content,
                    status: todo.status,
                    priority: todo.priority,
                    position,
                  })),
                )
                .run()
            }),
          )
          .pipe(Effect.orDie)
      }
      if (session) {
        yield* Effect.promise(() => writeSessionTodoState(session.location.directory, input.sessionID, input.todos))
      }
      yield* events.publish(Event.Updated, input)
    })

    const get = Effect.fn("SessionTodo.get")(function* (sessionID: SessionSchema.ID) {
      const session = yield* fileSession(sessionID)
      if (session) {
        const projection = yield* Effect.promise(() => readSessionTodoProjection(session.location.directory, sessionID))
        if (projection.hasState) return projection.todos
        return []
      }
      const rows = yield* db
        .select()
        .from(TodoTable)
        .where(eq(TodoTable.session_id, sessionID))
        .orderBy(asc(TodoTable.position))
        .all()
        .pipe(Effect.orDie)
      return rows.map((row) => ({
        content: row.content,
        status: row.status,
        priority: row.priority,
      }))
    })

    return Service.of({ update, get })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(EventV2.defaultLayer), Layer.provide(Database.defaultLayer))
