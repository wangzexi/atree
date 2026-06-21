export * as MoveSession from "./move-session"

import { Context, DateTime, Effect, Layer, Schema } from "effect"
import { EventV2 } from "../event"
import { Git } from "../git"
import { Location } from "../location"
import { ProjectV2 } from "../project"
import { SessionV2 } from "../session"
import { SessionExecution } from "../session/execution"
import { SessionEvent } from "../session/event"
import { publishSessionEvent } from "../session/publish-session-event"
import { SessionSchema } from "../session/schema"
import { moveSessionStore } from "../atree/session-store"
import { AbsolutePath, RelativePath } from "../schema"
import path from "path"

export const Destination = Schema.Struct({
  directory: AbsolutePath,
}).annotate({ identifier: "MoveSession.Destination" })
export type Destination = typeof Destination.Type

export const Input = Schema.Struct({
  sessionID: SessionSchema.ID,
  destination: Destination,
  moveChanges: Schema.optional(Schema.Boolean),
}).annotate({ identifier: "MoveSession.Input" })
export type Input = typeof Input.Type

export class DestinationProjectMismatchError extends Schema.TaggedErrorClass<DestinationProjectMismatchError>()(
  "MoveSession.DestinationProjectMismatchError",
  {
    expected: ProjectV2.ID,
    actual: ProjectV2.ID,
  },
) {}

export class ApplyChangesError extends Schema.TaggedErrorClass<ApplyChangesError>()("MoveSession.ApplyChangesError", {
  message: Schema.String,
}) {}

export class CaptureChangesError extends Schema.TaggedErrorClass<CaptureChangesError>()(
  "MoveSession.CaptureChangesError",
  {
    message: Schema.String,
  },
) {}

export class ResetSourceChangesError extends Schema.TaggedErrorClass<ResetSourceChangesError>()(
  "MoveSession.ResetSourceChangesError",
  {
    directory: AbsolutePath,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export type Error =
  | SessionV2.NotFoundError
  | DestinationProjectMismatchError
  | CaptureChangesError
  | ApplyChangesError
  | ResetSourceChangesError

export interface Interface {
  readonly moveSession: (input: Input) => Effect.Effect<void, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ControlPlaneMoveSession") {}

function sameDirectory(left: string, right: string) {
  return path.resolve(left) === path.resolve(right)
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const git = yield* Git.Service
    const events = yield* EventV2.Service
    const project = yield* ProjectV2.Service
    const session = yield* SessionV2.Service

    const moveSession = Effect.fn("MoveSession.moveSession")(function* (input: Input) {
      const current = yield* session.get(input.sessionID)
      const directory = AbsolutePath.make(input.destination.directory)
      if (sameDirectory(current.location.directory, directory)) return

      const source = yield* project.resolve(current.location.directory)
      const destination = yield* project.resolve(directory)
      if (current.projectID !== destination.id) {
        return yield* new DestinationProjectMismatchError({ expected: current.projectID, actual: destination.id })
      }

      const patch =
        input.moveChanges && !sameDirectory(source.directory, destination.directory)
          ? yield* git
              .patch(current.location.directory)
              .pipe(Effect.mapError((error) => new CaptureChangesError({ message: error.message })))
          : ""
      if (patch) {
        yield* git
          .applyPatch({ directory, patch })
          .pipe(Effect.mapError((error) => new ApplyChangesError({ message: error.message })))
      }

      const timestamp = yield* DateTime.now
      const movedFileSession = yield* Effect.promise(() =>
        moveSessionStore(current, directory, DateTime.toEpochMillis(timestamp)),
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("failed to move atree session store", {
            sessionID: input.sessionID,
            source: current.location.directory,
            destination: directory,
            cause,
          }),
        ),
      )
      const moved = {
        sessionID: input.sessionID,
        location: Location.Ref.make({ directory }),
        subdirectory: RelativePath.make(path.relative(destination.directory, directory).replaceAll("\\", "/")),
        timestamp,
      }
      if (movedFileSession) {
        yield* publishSessionEvent(
          events,
          { sessionID: input.sessionID, session: movedFileSession },
          SessionEvent.Moved,
          moved,
          "move session event",
        )
      } else {
        yield* events.publish(SessionEvent.Moved, moved)
      }

      if (patch) {
        yield* git.softResetChanges(current.location.directory).pipe(
          Effect.mapError(
            (error) =>
              new ResetSourceChangesError({
                directory: current.location.directory,
                message: error.message,
                cause: error.cause,
              }),
          ),
        )
      }
    })

    return Service.of({ moveSession })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Git.defaultLayer),
  Layer.provide(EventV2.defaultLayer),
  Layer.provide(ProjectV2.defaultLayer),
  Layer.provide(SessionExecution.noopLayer),
  Layer.provide(SessionV2.defaultLayer),
)
