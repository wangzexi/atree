import { Effect } from "effect"
import { appendSessionJsonl } from "../atree/session-store"
import { EventV2 } from "../event"
import { SessionSchema } from "./schema"

type Input = {
  readonly sessionID: SessionSchema.ID
  readonly session?: SessionSchema.Info
}

export const publishSessionEvent = <D extends EventV2.Definition>(
  events: EventV2.Interface,
  input: Input,
  definition: D,
  data: EventV2.Data<D>,
  context: string,
): Effect.Effect<EventV2.Payload<D>> =>
  Effect.gen(function* () {
    const payload = yield* events.publish(definition, data)
    if (input.session) {
      yield* Effect.promise(() =>
        appendSessionJsonl(input.session!, {
          type: definition.type,
          ...(data as Record<string, unknown>),
        }),
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning(`failed to mirror ${context} into atree session log`, {
            sessionID: input.sessionID,
            type: definition.type,
            cause,
          }),
        ),
      )
    }
    return payload
  })
