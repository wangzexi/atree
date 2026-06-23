export * as SessionStore from "./store"

import { eq } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { Database } from "../database/database"
import { SessionHistory } from "./history"
import { MessageDecodeError } from "./error"
import { SessionMessage } from "./message"
import { SessionSchema } from "./schema"
import { SessionInputTable, SessionMessageTable, SessionTable } from "./sql"
import { fromRow } from "./info"
import {
  findSessionJsonlMessage,
  findSessionStore,
  readSessionJsonlMessages,
  readSessionStore,
  readWorkspaceRoot,
} from "../atree/session-store"

export interface Interface {
  readonly get: (
    sessionID: SessionSchema.ID,
    options?: { directory?: string },
  ) => Effect.Effect<SessionSchema.Info | undefined>
  readonly context: (
    sessionID: SessionSchema.ID,
    options?: { directory?: string },
  ) => Effect.Effect<SessionMessage.Message[], MessageDecodeError>
  readonly runnerEntries: (
    sessionID: SessionSchema.ID,
    baselineSeq: number,
    options?: { directory?: string },
  ) => Effect.Effect<Array<{ readonly seq: number; readonly message: SessionMessage.Message }>, MessageDecodeError>
  readonly runnerContext: (
    sessionID: SessionSchema.ID,
    baselineSeq: number,
    options?: { directory?: string },
  ) => Effect.Effect<SessionMessage.Message[], MessageDecodeError>
  readonly message: (
    messageID: SessionMessage.ID,
  ) => Effect.Effect<{ readonly sessionID: SessionSchema.ID; readonly message: SessionMessage.Message } | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/SessionStore") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const decodeMessage = Schema.decodeUnknownEffect(SessionMessage.Message)
    const resolveFileSession = Effect.fn("SessionStore.resolveFileSession")(function* (
      sessionID: SessionSchema.ID,
      directory?: string,
    ) {
      const row = yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie)
      const cached = row ? fromRow(row) : undefined
      if (directory) {
        const fileSession = yield* Effect.promise(() => readSessionStore(directory, sessionID)).pipe(
          Effect.catchCause(() => Effect.succeed(undefined)),
        )
        if (fileSession) return fileSession
        return undefined
      }
      const root = yield* Effect.promise(() => readWorkspaceRoot()).pipe(
        Effect.catchCause(() => Effect.succeed<string | undefined>(undefined)),
      )
      if (root) {
        const fileSession = yield* Effect.promise(() => findSessionStore(root, sessionID)).pipe(
          Effect.catchCause(() => Effect.succeed<SessionSchema.Info | undefined>(undefined)),
        )
        if (fileSession) return fileSession
      }
      if (cached) {
        const fileSession = yield* Effect.promise(() => readSessionStore(cached.location.directory, sessionID)).pipe(
          Effect.catchCause(() => Effect.succeed(undefined)),
        )
        if (fileSession) return fileSession
      }
      return undefined
    })

    const findFileBackedMessage = Effect.fn("SessionStore.findFileBackedMessage")(function* (
      messageID: SessionMessage.ID,
    ) {
      const root = yield* Effect.promise(() => readWorkspaceRoot()).pipe(
        Effect.catchCause(() => Effect.succeed<string | undefined>(undefined)),
      )
      if (!root) return undefined
      const found = yield* Effect.promise(() => findSessionJsonlMessage(root, messageID)).pipe(
        Effect.catchCause(() =>
          Effect.succeed<
            | {
                session: SessionSchema.Info
                message: SessionMessage.Message
              }
            | undefined
          >(undefined),
        ),
      )
      return found ? { sessionID: found.session.id, message: found.message } : undefined
    })

    const findFileBackedSession = Effect.fn("SessionStore.findFileBackedSession")(function* (
      sessionID: SessionSchema.ID,
      directory?: string,
    ) {
      const root = yield* Effect.promise(() => readWorkspaceRoot()).pipe(
        Effect.catchCause(() => Effect.succeed<string | undefined>(undefined)),
      )
      if (root) {
        const fileSession = yield* Effect.promise(() => findSessionStore(root, sessionID)).pipe(
          Effect.catchCause(() => Effect.succeed<SessionSchema.Info | undefined>(undefined)),
        )
        if (fileSession) return fileSession
      }
      if (directory) {
        const fileSession = yield* Effect.promise(() => readSessionStore(directory, sessionID)).pipe(
          Effect.catchCause(() => Effect.succeed(undefined)),
        )
        if (fileSession) return fileSession
      }
      return undefined
    })

    const persistedRootOwnsSession = Effect.fn("SessionStore.persistedRootOwnsSession")(function* (
      sessionID: SessionSchema.ID,
    ) {
      const root = yield* Effect.promise(() => readWorkspaceRoot()).pipe(
        Effect.catchCause(() => Effect.succeed<string | undefined>(undefined)),
      )
      if (!root) return false
      const fileSession = yield* Effect.promise(() => findSessionStore(root, sessionID)).pipe(
        Effect.catchCause(() => Effect.succeed<SessionSchema.Info | undefined>(undefined)),
      )
      return fileSession !== undefined
    })

    const runnerEntries = Effect.fn("SessionStore.runnerEntries")(function* (
      sessionID: SessionSchema.ID,
      baselineSeq: number,
      options?: { directory?: string },
    ) {
      const fileSession = yield* resolveFileSession(sessionID, options?.directory)
      if (fileSession) {
        const messages = yield* Effect.promise(() => readSessionJsonlMessages(fileSession)).pipe(
          Effect.catchCause(() => Effect.succeed([] as SessionMessage.Message[])),
        )
        if (messages.length === 0 && !options?.directory && !(yield* persistedRootOwnsSession(sessionID)))
          return yield* SessionHistory.entriesForRunner(db, sessionID, baselineSeq)
        const inputRows = yield* db
          .select({
            id: SessionInputTable.id,
            promotedSeq: SessionInputTable.promoted_seq,
          })
          .from(SessionInputTable)
          .where(eq(SessionInputTable.session_id, sessionID))
          .all()
          .pipe(Effect.orDie)
        const inputState = new Map(inputRows.map((row) => [row.id, row.promotedSeq]))
        return messages
          .map((message, index) => ({ seq: index + 1, message }))
          .filter((entry) => {
            if (entry.message.type !== "user") return true
            const promotedSeq = inputState.get(entry.message.id)
            return promotedSeq === undefined || promotedSeq !== null
          })
          .filter((entry) => entry.message.type !== "system" || entry.seq > baselineSeq)
      }
      return yield* SessionHistory.entriesForRunner(db, sessionID, baselineSeq)
    })

    return Service.of({
      get: Effect.fn("SessionStore.get")(function* (sessionID, options) {
        return yield* resolveFileSession(sessionID, options?.directory)
      }),
      context: Effect.fn("SessionStore.context")(function* (sessionID, options) {
        const fileSession = yield* resolveFileSession(sessionID, options?.directory)
        if (fileSession) {
          const messages = yield* Effect.promise(() => readSessionJsonlMessages(fileSession)).pipe(
            Effect.catchCause(() => Effect.succeed([] as SessionMessage.Message[])),
          )
          if (messages.length === 0 && !options?.directory && !(yield* persistedRootOwnsSession(sessionID)))
            return yield* SessionHistory.load(db, sessionID)
          return messages
        }
        if (options?.directory) return []
        const stored = yield* SessionHistory.load(db, sessionID)
        return stored
      }),
      runnerEntries,
      runnerContext: Effect.fn("SessionStore.runnerContext")(function* (sessionID, baselineSeq, options) {
        return (yield* runnerEntries(sessionID, baselineSeq, options)).map((entry) => entry.message)
      }),
      message: Effect.fn("SessionStore.message")(function* (messageID) {
        const row = yield* db
          .select()
          .from(SessionMessageTable)
          .where(eq(SessionMessageTable.id, messageID))
          .get()
          .pipe(Effect.orDie)
        const fileMessage = yield* findFileBackedMessage(messageID)
        if (fileMessage) return fileMessage
        if (!row) return undefined

        const cachedSession = yield* db
          .select({ directory: SessionTable.directory })
          .from(SessionTable)
          .where(eq(SessionTable.id, row.session_id))
          .get()
          .pipe(Effect.orDie)
        const fileSession = yield* findFileBackedSession(SessionSchema.ID.make(row.session_id), cachedSession?.directory)
        if (fileSession) {
          const messages = yield* Effect.promise(() => readSessionJsonlMessages(fileSession)).pipe(
            Effect.catchCause(() => Effect.succeed([] as SessionMessage.Message[])),
          )
          if (!messages.some((message) => message.id === messageID)) return undefined
        }

        return {
          sessionID: SessionSchema.ID.make(row.session_id),
          message: yield* decodeMessage({ ...row.data, id: row.id, type: row.type }).pipe(Effect.orDie),
        }
      }),
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Database.defaultLayer))
