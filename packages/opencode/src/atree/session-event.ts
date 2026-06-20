import { Effect } from "effect"
import { appendSessionJsonl, findSessionStore } from "./session-store"
import { readWorkspaceState } from "./state"
import { InstanceState } from "@/effect/instance-state"
import type { SessionID } from "@/session/schema"

export const appendAtreeSessionEventByID = (
  sessionID: SessionID,
  entry: Record<string, unknown>,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const instanceDirectory = yield* InstanceState.directory.pipe(
      Effect.catchCause(() => Effect.succeed<string | undefined>(undefined)),
    )
    if (instanceDirectory) {
      const session = yield* Effect.promise(() => findSessionStore(instanceDirectory, sessionID))
      if (session) {
        yield* Effect.promise(() => appendSessionJsonl(session, entry))
        return
      }
    }

    const state = yield* Effect.promise(() => readWorkspaceState()).pipe(
      Effect.catchCause(() => Effect.succeed({ rootDirectory: null })),
    )
    if (!state.rootDirectory) return
    const session = yield* Effect.promise(() => findSessionStore(state.rootDirectory!, sessionID))
    if (!session) return
    yield* Effect.promise(() => appendSessionJsonl(session, entry))
  })

export const appendAtreeSessionEventByIDBestEffort = (
  sessionID: SessionID,
  entry: Record<string, unknown>,
): Effect.Effect<void> =>
  appendAtreeSessionEventByID(sessionID, entry).pipe(
    Effect.catchCause((cause) => Effect.logWarning("failed to append atree session event", { sessionID, cause })),
  )
