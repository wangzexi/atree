import { Effect } from "effect"
import { appendSessionJsonl, readSessionStore, touchSessionStore } from "./session-store"
import { resolveFileSession, type FileSession } from "./session-resolver"
import { InstanceState } from "@/effect/instance-state"
import type { SessionID } from "@/session/schema"

const findSessionInDirectory = (directory: string | undefined, sessionID: SessionID) =>
  Effect.gen(function* () {
    if (!directory) return
    return yield* Effect.promise(() => readSessionStore(directory, sessionID)).pipe(
      Effect.catchCause(() => Effect.succeed(undefined)),
    )
  })

const appendToSession = (session: FileSession, entry: Record<string, unknown>) =>
  Effect.gen(function* () {
    yield* Effect.promise(() => appendSessionJsonl(session, entry))
    yield* Effect.promise(() => touchSessionStore(session.directory, session.id))
  })

export const appendAtreeSessionEventInDirectory = (
  directory: string | undefined,
  sessionID: SessionID,
  entry: Record<string, unknown>,
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const session = yield* findSessionInDirectory(directory, sessionID)
    if (!session) return false
    yield* appendToSession(session, entry)
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
    const session = yield* resolveFileSession({ sessionID, instanceDirectory })
    if (!session) return
    yield* appendToSession(session, entry)
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
