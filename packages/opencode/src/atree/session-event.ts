import { Effect } from "effect"
import { appendSessionJsonl, findSessionStore, readSessionStore, touchSessionStore } from "./session-store"
import { readWorkspaceRootDirectory } from "./state"
import { InstanceState } from "@/effect/instance-state"
import type { SessionID } from "@/session/schema"

const findSessionInDirectory = (directory: string | undefined, sessionID: SessionID) =>
  Effect.gen(function* () {
    if (!directory) return
    return yield* Effect.promise(() => readSessionStore(directory, sessionID)).pipe(
      Effect.catchCause(() => Effect.succeed(undefined)),
    )
  })

export const appendAtreeSessionEventInDirectory = (
  directory: string | undefined,
  sessionID: SessionID,
  entry: Record<string, unknown>,
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const session = yield* findSessionInDirectory(directory, sessionID)
    if (!session) return false
    yield* Effect.promise(() => appendSessionJsonl(session, entry))
    yield* Effect.promise(() => touchSessionStore(session.directory, session.id))
    return true
  })

export const appendAtreeSessionEventByID = (
  sessionID: SessionID,
  entry: Record<string, unknown>,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const instanceDirectory = yield* InstanceState.directory.pipe(
      Effect.catchCause(() => Effect.succeed<string | undefined>(undefined)),
    )
    const instanceSession = yield* findSessionInDirectory(instanceDirectory, sessionID)
    if (instanceSession) {
      yield* Effect.promise(() => appendSessionJsonl(instanceSession, entry))
      yield* Effect.promise(() => touchSessionStore(instanceSession.directory, instanceSession.id))
      return
    }
    const instanceNestedSession = instanceDirectory
      ? yield* Effect.promise(() => findSessionStore(instanceDirectory, sessionID)).pipe(
          Effect.catchCause(() => Effect.succeed(undefined)),
        )
      : undefined
    if (instanceNestedSession) {
      yield* Effect.promise(() => appendSessionJsonl(instanceNestedSession, entry))
      yield* Effect.promise(() => touchSessionStore(instanceNestedSession.directory, instanceNestedSession.id))
      return
    }

    const rootDirectory = yield* Effect.promise(() => readWorkspaceRootDirectory()).pipe(
      Effect.catchCause(() => Effect.succeed<string | undefined>(undefined)),
    )
    const session = rootDirectory
      ? yield* Effect.promise(() => findSessionStore(rootDirectory, sessionID)).pipe(
          Effect.catchCause(() => Effect.succeed(undefined)),
        )
      : undefined
    if (!session) return
    yield* Effect.promise(() => appendSessionJsonl(session, entry))
    yield* Effect.promise(() => touchSessionStore(session.directory, session.id))
  })

export const appendAtreeSessionEventByIDBestEffort = (
  sessionID: SessionID,
  entry: Record<string, unknown>,
): Effect.Effect<void> =>
  appendAtreeSessionEventByID(sessionID, entry).pipe(
    Effect.catchCause((cause) => Effect.logWarning("failed to append atree session event", { sessionID, cause })),
  )

export const appendAtreeSessionEventBestEffort = (
  directory: string | undefined,
  sessionID: SessionID,
  entry: Record<string, unknown>,
): Effect.Effect<void> =>
  appendAtreeSessionEventInDirectory(directory, sessionID, entry).pipe(
    Effect.flatMap((written) => (written || directory ? Effect.void : appendAtreeSessionEventByID(sessionID, entry))),
    Effect.catchCause((cause) => Effect.logWarning("failed to append atree session event", { sessionID, cause })),
  )
