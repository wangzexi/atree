import path from "path"
import { Effect } from "effect"
import type { SessionID } from "@/session/schema"
import { findSessionStore, findWorkspaceSessionStore, readSessionStore } from "./session-store"

export type FileSession = NonNullable<Awaited<ReturnType<typeof readSessionStore>>>

function sameDirectory(left: string | undefined, right: string | undefined) {
  if (!left || !right) return false
  return path.resolve(left) === path.resolve(right)
}

export const resolveFileSession = Effect.fn("Atree.resolveFileSession")(function* (input: {
  sessionID: SessionID
  directory?: string
  instanceDirectory?: string
}) {
  const tried = new Set<string>()

  const tryDirectory = Effect.fnUntraced(function* (directory: string | undefined) {
    if (!directory) return
    const normalized = path.resolve(directory)
    if (tried.has(normalized)) return
    tried.add(normalized)
    return yield* Effect.promise(() => readSessionStore(normalized, input.sessionID))
  })

  const explicit = yield* tryDirectory(input.directory)
  if (explicit) return explicit
  if (input.directory) {
    const found = yield* Effect.promise(() => findSessionStore(path.resolve(input.directory!), input.sessionID)).pipe(
      Effect.catchCause(() => Effect.succeed(undefined)),
    )
    if (found) return found
    return
  }

  const instance = sameDirectory(input.instanceDirectory, input.directory)
    ? undefined
    : yield* tryDirectory(input.instanceDirectory)
  if (instance) return instance

  const found = yield* Effect.promise(() => findWorkspaceSessionStore(input.sessionID)).pipe(
    Effect.catchCause(() => Effect.succeed(undefined)),
  )
  if (found) return found
})
