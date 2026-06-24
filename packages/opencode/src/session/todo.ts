import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionID } from "./schema"
import { Effect, Layer, Context, Schema } from "effect"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Location } from "@opencode-ai/core/location"
import { EventV2Bridge } from "@/event-v2-bridge"
import { EventV2 } from "@opencode-ai/core/event"
import { appendSessionJsonl, readSessionStore } from "@/atree/session-store"
import { readSessionTodoProjection, writeSessionTodoState } from "@/atree/todo-store"
import { resolveFileSession } from "@/atree/session-resolver"
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
  readonly update: (input: { sessionID: SessionID; todos: Info[]; directory?: string }) => Effect.Effect<void>
  readonly get: (sessionID: SessionID, options?: { directory?: string }) => Effect.Effect<Info[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionTodo") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service

    type FileSession = NonNullable<Awaited<ReturnType<typeof readSessionStore>>>
    type FileSessionResolution = { type: "found"; session: FileSession } | { type: "none" }
    const currentInstance = InstanceRef.pipe(Effect.catchCause(() => Effect.succeed(undefined)))

    const fileSessionForTodo = Effect.fn("Todo.fileSessionForTodo")(function* (
      sessionID: SessionID,
      fallbackDirectory?: string,
    ) {
      const instance = yield* currentInstance
      const fileSession = yield* resolveFileSession({
        sessionID,
        directory: fallbackDirectory,
        instanceDirectory: instance?.directory,
      })
      if (!fileSession) {
        return { type: "none" }
      }
      return { type: "found", session: fileSession } satisfies FileSessionResolution
    })

    const appendTodoSessionEvent = Effect.fn("Todo.appendTodoSessionEvent")(function* (
      session: FileSession,
      todos: Info[],
    ) {
      yield* Effect.promise(() =>
        appendSessionJsonl(session, {
          type: "todo.updated",
          sessionID: session.id,
          todos,
        }),
      )
    })

    function todoLocation(session: FileSession | undefined) {
      return session ? { location: new Location.Ref({ directory: AbsolutePath.make(session.directory) }) } : undefined
    }

    const update = Effect.fn("Todo.update")(function* (input: {
      sessionID: SessionID
      todos: Info[]
      directory?: string
    }) {
      const resolved = yield* fileSessionForTodo(input.sessionID, input.directory)
      const fileSession = resolved.type === "found" ? resolved.session : undefined
      if (!fileSession) return
      if (fileSession) {
        yield* appendTodoSessionEvent(fileSession, input.todos).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("failed to append todo event to atree session log", {
              sessionID: input.sessionID,
              cause,
            }),
          ),
        )
      }
      if (fileSession) {
        yield* Effect.promise(() => writeSessionTodoState(fileSession.directory, input.sessionID, input.todos))
      }
      yield* events.publish(Event.Updated, input, todoLocation(fileSession))
    })

    const get = Effect.fn("Todo.get")(function* (sessionID: SessionID, options?: { directory?: string }) {
      const resolved = yield* fileSessionForTodo(sessionID, options?.directory)
      const fileSession = resolved.type === "found" ? resolved.session : undefined
      if (fileSession) {
        const projection = yield* Effect.promise(() => readSessionTodoProjection(fileSession.directory, sessionID))
        if (projection.hasState) return projection.todos
        return []
      }
      return []
    })

    return Service.of({ update, get })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(EventV2Bridge.defaultLayer))

export const node = LayerNode.make(layer, [EventV2Bridge.node])

export * as Todo from "./todo"
