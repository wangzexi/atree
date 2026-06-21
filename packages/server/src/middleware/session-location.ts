import { findSessionStore, readSessionStore, readWorkspaceRoot } from "@opencode-ai/core/atree/session-store"
import { LocationServiceMap } from "@opencode-ai/core/location-layer"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { Effect, Layer, Schema } from "effect"
import { HttpRouter, HttpServerRequest } from "effect/unstable/http"
import { HttpApiMiddleware } from "effect/unstable/httpapi"
import { InvalidRequestError, SessionNotFoundError } from "../errors"
import type { LocationServices } from "../groups/location"

export class SessionLocationMiddleware extends HttpApiMiddleware.Service<
  SessionLocationMiddleware,
  {
    provides: LocationServices
  }
>()("@opencode/HttpApiSessionLocation", {
  error: [InvalidRequestError, SessionNotFoundError],
}) {}

const decodeSessionID = Schema.decodeUnknownEffect(SessionV2.ID)

function decodeHeader(input: string | undefined) {
  if (!input) return
  try {
    return decodeURIComponent(input)
  } catch {
    return input
  }
}

export const sessionLocationLayer = Layer.effect(
  SessionLocationMiddleware,
  Effect.gen(function* () {
    const locations = yield* LocationServiceMap

    return SessionLocationMiddleware.of((effect) =>
      Effect.gen(function* () {
        const route = yield* HttpRouter.RouteContext
        const request = yield* HttpServerRequest.HttpServerRequest
        const requestDirectory = decodeHeader(request.headers["x-opencode-directory"])
        const sessionID = yield* decodeSessionID(route.params.sessionID).pipe(
          Effect.mapError(
            () =>
              new InvalidRequestError({
                message: "Invalid session ID",
                field: "sessionID",
              }),
          ),
        )
        const hintedFileSession =
          requestDirectory === undefined
            ? undefined
            : yield* Effect.promise(() => readSessionStore(requestDirectory, sessionID)).pipe(
                Effect.catchCause(() => Effect.succeed(undefined)),
              )
        const rootFileSession = requestDirectory
          ? undefined
          : yield* Effect.promise(() => readWorkspaceRoot()).pipe(
              Effect.flatMap((root) =>
                root ? Effect.promise(() => findSessionStore(root, sessionID)) : Effect.succeed(undefined),
              ),
              Effect.catchCause(() => Effect.succeed(undefined)),
            )
        const fileSession = hintedFileSession ?? rootFileSession
        const directory = fileSession?.location.directory ?? requestDirectory
        const workspaceID = fileSession?.location.workspaceID
        if (!directory)
          return yield* new SessionNotFoundError({
            sessionID,
            message: `Session not found: ${sessionID}`,
          })

        return yield* effect.pipe(
          Effect.provide(
            locations.get(
              Location.Ref.make({
                directory: AbsolutePath.make(directory),
                workspaceID: workspaceID ? WorkspaceV2.ID.make(workspaceID) : undefined,
              }),
            ),
          ),
        )
      }),
    )
  }),
)
