import path from "path"
import { Effect } from "effect"
import { eq } from "drizzle-orm"
import type { Database } from "@opencode-ai/core/database/database"
import { SessionTable } from "@opencode-ai/core/session/sql"
import type { SessionID } from "@/session/schema"
import { findSessionStore, readSessionStore } from "./session-store"
import { readWorkspaceState } from "./state"

export type FileSession = NonNullable<Awaited<ReturnType<typeof readSessionStore>>>

function sameDirectory(left: string | undefined, right: string | undefined) {
  if (!left || !right) return false
  return path.resolve(left) === path.resolve(right)
}

export const resolveFileSession = Effect.fn("Atree.resolveFileSession")(function* (
  db: Database.Interface["db"],
  input: {
    sessionID: SessionID
    directory?: string
    instanceDirectory?: string
  },
) {
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

  const instance = sameDirectory(input.instanceDirectory, input.directory)
    ? undefined
    : yield* tryDirectory(input.instanceDirectory)
  if (instance) return instance

  const state = yield* Effect.promise(() => readWorkspaceState()).pipe(
    Effect.catchCause(() => Effect.succeed({ rootDirectory: null })),
  )
  if (state.rootDirectory) {
    const found = yield* Effect.promise(() => findSessionStore(state.rootDirectory!, input.sessionID)).pipe(
      Effect.catchCause(() => Effect.succeed(undefined)),
    )
    if (found) return found
  }

  const cached = yield* db
    .select({ directory: SessionTable.directory })
    .from(SessionTable)
    .where(eq(SessionTable.id, input.sessionID))
    .get()
    .pipe(Effect.catchCause(() => Effect.succeed(undefined)))
  return yield* tryDirectory(cached?.directory)
})
