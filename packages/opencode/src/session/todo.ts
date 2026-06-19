import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionID } from "./schema"
import { Effect, Layer, Context, Schema } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { eq } from "drizzle-orm"
import { asc } from "drizzle-orm"
import { SessionTable, TodoTable } from "@opencode-ai/core/session/sql"
import { EventV2Bridge } from "@/event-v2-bridge"
import { EventV2 } from "@opencode-ai/core/event"
import { readSessionStore } from "@/atree/session-store"
import { readSessionTodoProjection, writeSessionTodoState } from "@/atree/todo-store"
import { InstanceRef } from "@/effect/instance-ref"

export const Info = Schema.Struct({
  content: Schema.String.annotate({ description: "Brief description of the task" }),
  status: Schema.String.annotate({
    description: "Current status of the task: pending, in_progress, completed, cancelled",
  }),
  priority: Schema.String.annotate({ description: "Priority level of the task: high, medium, low" }),
}).annotate({ identifier: "Todo" })
export type Info = Schema.Schema.Type<typeof Info>

export const Event = {
  Updated: EventV2.define({
    type: "todo.updated",
    schema: {
      sessionID: SessionID,
      todos: Schema.Array(Info),
    },
  }),
}

export interface Interface {
  readonly update: (input: { sessionID: SessionID; todos: Info[] }) => Effect.Effect<void>
  readonly get: (sessionID: SessionID, options?: { directory?: string }) => Effect.Effect<Info[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionTodo") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const { db } = yield* Database.Service

    const sessionDirectory = Effect.fn("Todo.sessionDirectory")(function* (
      sessionID: SessionID,
      fallbackDirectory?: string,
    ) {
      const row = yield* db
        .select({ directory: SessionTable.directory })
        .from(SessionTable)
        .where(eq(SessionTable.id, sessionID))
        .get()
        .pipe(Effect.orDie)
      if (row?.directory) return row.directory

      if (fallbackDirectory) {
        const fileSession = yield* Effect.promise(() => readSessionStore(fallbackDirectory, sessionID))
        if (fileSession) return fileSession.directory
      }

      const instance = yield* InstanceRef
      if (!instance) return
      const fileSession = yield* Effect.promise(() => readSessionStore(instance.directory, sessionID))
      return fileSession ? instance.directory : undefined
    })

    const update = Effect.fn("Todo.update")(function* (input: { sessionID: SessionID; todos: Info[] }) {
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
      const directory = yield* sessionDirectory(input.sessionID)
      if (directory) yield* Effect.promise(() => writeSessionTodoState(directory, input.sessionID, input.todos))
      yield* events.publish(Event.Updated, input)
    })

    const get = Effect.fn("Todo.get")(function* (sessionID: SessionID, options?: { directory?: string }) {
      const directory = yield* sessionDirectory(sessionID, options?.directory)
      if (directory) {
        const projection = yield* Effect.promise(() => readSessionTodoProjection(directory, sessionID))
        if (projection.hasState) return projection.todos
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

export const defaultLayer = layer.pipe(Layer.provide(EventV2Bridge.defaultLayer), Layer.provide(Database.defaultLayer))

export const node = LayerNode.make(layer, [EventV2Bridge.node, Database.node])

export * as Todo from "./todo"
