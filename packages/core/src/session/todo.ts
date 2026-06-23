export * as SessionTodo from "./todo"

import { Context, Effect, Layer, Schema } from "effect"
import { appendSessionJsonl, findSessionStore, readSessionStore, readWorkspaceRoot } from "../atree/session-store"
import { readSessionTodoProjection, writeSessionTodoState } from "../atree/todo-store"
import { Database } from "../database/database"
import { EventV2 } from "../event"
import { SessionSchema } from "./schema"

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
    readonly directory?: string
    readonly todos: ReadonlyArray<Info>
  }) => Effect.Effect<void>
  readonly get: (
    sessionID: SessionSchema.ID,
    options?: { readonly directory?: string },
  ) => Effect.Effect<ReadonlyArray<Info>>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/SessionTodo") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    type FileSessionResolution =
      | { type: "found"; session: NonNullable<Awaited<ReturnType<typeof readSessionStore>>> }
      | { type: "none" }

    const fileSession = Effect.fn("SessionTodo.fileSession")(function* (
      sessionID: SessionSchema.ID,
      directory?: string,
    ) {
      if (directory) {
        const session = yield* Effect.promise(() => readSessionStore(directory, sessionID)).pipe(
          Effect.catchCause(() => Effect.succeed(undefined)),
        )
        return session ? { type: "found", session } : { type: "none" }
      }
      const root = yield* Effect.promise(() => readWorkspaceRoot()).pipe(
        Effect.catchCause(() => Effect.succeed<string | undefined>(undefined)),
      )
      if (root) {
        const session = yield* Effect.promise(() => findSessionStore(root, sessionID)).pipe(
          Effect.catchCause(() => Effect.succeed(undefined)),
        )
        if (session) return { type: "found", session }
      }
      return { type: "none" }
    })

    const update = Effect.fn("SessionTodo.update")(function* (input: {
      readonly sessionID: SessionSchema.ID
      readonly directory?: string
      readonly todos: ReadonlyArray<Info>
    }) {
      const resolved = yield* fileSession(input.sessionID, input.directory)
      const session = resolved.type === "found" ? resolved.session : undefined
      if (!session) return
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
      if (session) {
        yield* Effect.promise(() => writeSessionTodoState(session.location.directory, input.sessionID, input.todos))
      }
      yield* events.publish(Event.Updated, input)
    })

    const get = Effect.fn("SessionTodo.get")(function* (
      sessionID: SessionSchema.ID,
      options?: { readonly directory?: string },
    ) {
      const resolved = yield* fileSession(sessionID, options?.directory)
      const session = resolved.type === "found" ? resolved.session : undefined
      if (session) {
        const projection = yield* Effect.promise(() => readSessionTodoProjection(session.location.directory, sessionID))
        if (projection.hasState) return projection.todos
        return []
      }
      return []
    })

    return Service.of({ update, get })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(EventV2.defaultLayer), Layer.provide(Database.defaultLayer))
