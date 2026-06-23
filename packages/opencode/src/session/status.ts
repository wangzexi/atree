import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { InstanceState } from "@/effect/instance-state"
import { SessionID } from "./schema"
import { AbsolutePath, NonNegativeInt } from "@opencode-ai/core/schema"
import { Effect, Layer, Context, Schema } from "effect"
import { EventV2Bridge } from "@/event-v2-bridge"
import { EventV2 } from "@opencode-ai/core/event"
import { Location } from "@opencode-ai/core/location"
import path from "path"

export const Info = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("idle"),
  }),
  Schema.Struct({
    type: Schema.Literal("retry"),
    attempt: NonNegativeInt,
    message: Schema.String,
    action: Schema.optional(
      Schema.Struct({
        reason: Schema.String,
        provider: Schema.String,
        title: Schema.String,
        message: Schema.String,
        label: Schema.String,
        link: Schema.optional(Schema.String),
      }),
    ),
    next: NonNegativeInt,
  }),
  Schema.Struct({
    type: Schema.Literal("busy"),
  }),
]).annotate({ identifier: "SessionStatus" })
export type Info = Schema.Schema.Type<typeof Info>

export const Event = {
  Status: EventV2.define({
    type: "session.status",
    schema: {
      sessionID: SessionID,
      status: Info,
    },
  }),
  // deprecated
  Idle: EventV2.define({
    type: "session.idle",
    schema: {
      sessionID: SessionID,
    },
  }),
}

export interface Interface {
  readonly get: (sessionID: SessionID, options?: { directory?: string }) => Effect.Effect<Info>
  readonly list: () => Effect.Effect<Map<SessionID, Info>>
  readonly set: (sessionID: SessionID, status: Info, options?: { directory?: string }) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionStatus") {}

function statusLocation(directory?: string) {
  return directory ? { location: new Location.Ref({ directory: AbsolutePath.make(directory) }) } : undefined
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service

    const state = yield* InstanceState.make(
      Effect.fn("SessionStatus.state")(() => Effect.succeed(new Map<string, { sessionID: SessionID; status: Info }>())),
    )
    const fallbackState = new Map<string, { sessionID: SessionID; status: Info }>()
    const currentState = InstanceState.get(state).pipe(Effect.catchCause(() => Effect.succeed(fallbackState)))

    const key = (sessionID: SessionID, directory?: string) =>
      `${directory ? path.resolve(directory) : ""}\0${sessionID}`

    const get = Effect.fn("SessionStatus.get")(function* (sessionID: SessionID, options?: { directory?: string }) {
      const data = yield* currentState
      if (options?.directory !== undefined) {
        return data.get(key(sessionID, options.directory))?.status ?? { type: "idle" as const }
      }
      for (const current of data.values()) {
        if (current.sessionID === sessionID) return current.status
      }
      return { type: "idle" as const }
    })

    const list = Effect.fn("SessionStatus.list")(function* () {
      const result = new Map<SessionID, Info>()
      for (const { sessionID, status } of (yield* currentState).values()) {
        result.set(sessionID, status)
      }
      return result
    })

    const set = Effect.fn("SessionStatus.set")(function* (
      sessionID: SessionID,
      status: Info,
      options?: { directory?: string },
    ) {
      const data = yield* currentState
      yield* events.publish(Event.Status, { sessionID, status }, statusLocation(options?.directory))
      if (status.type === "idle") {
        yield* events.publish(Event.Idle, { sessionID }, statusLocation(options?.directory))
        data.delete(key(sessionID, options?.directory))
        return
      }
      data.set(key(sessionID, options?.directory), { sessionID, status })
    })

    return Service.of({ get, list, set })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(EventV2Bridge.defaultLayer))

export const node = LayerNode.make(layer, [EventV2Bridge.node])

export * as SessionStatus from "./status"
