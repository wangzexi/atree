export * as SessionStore from "./store"

import { eq } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { Database } from "../database/database"
import { SessionHistory } from "./history"
import { MessageDecodeError } from "./error"
import { SessionMessage } from "./message"
import { SessionSchema } from "./schema"
import { SessionMessageTable, SessionTable } from "./sql"
import { fromRow } from "./info"
import {
  findSessionJsonlMessage,
  findSessionStore,
  readSessionJsonlMessages,
  readSessionStore,
  readWorkspaceRoot,
} from "../atree/session-store"

export interface Interface {
  readonly get: (sessionID: SessionSchema.ID) => Effect.Effect<SessionSchema.Info | undefined>
  readonly context: (sessionID: SessionSchema.ID) => Effect.Effect<SessionMessage.Message[], MessageDecodeError>
  readonly runnerEntries: (
    sessionID: SessionSchema.ID,
    baselineSeq: number,
  ) => Effect.Effect<Array<{ readonly seq: number; readonly message: SessionMessage.Message }>, MessageDecodeError>
  readonly runnerContext: (
    sessionID: SessionSchema.ID,
    baselineSeq: number,
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
    const resolveFileSession = Effect.fn("SessionStore.resolveFileSession")(function* (sessionID: SessionSchema.ID) {
      const row = yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie)
      const cached = row ? fromRow(row) : undefined
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
      return cached
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

    const runnerEntries = Effect.fn("SessionStore.runnerEntries")(function* (
      sessionID: SessionSchema.ID,
      baselineSeq: number,
    ) {
      const fileSession = yield* resolveFileSession(sessionID)
      if (fileSession) {
        const messages = yield* Effect.promise(() => readSessionJsonlMessages(fileSession)).pipe(
          Effect.catchCause(() => Effect.succeed([] as SessionMessage.Message[])),
        )
        return messages
          .map((message, index) => ({ seq: index + 1, message }))
          .filter((entry) => entry.message.type !== "system" || entry.seq > baselineSeq)
      }
      return yield* SessionHistory.entriesForRunner(db, sessionID, baselineSeq)
    })

    return Service.of({
      get: Effect.fn("SessionStore.get")(function* (sessionID) {
        return yield* resolveFileSession(sessionID)
      }),
      context: Effect.fn("SessionStore.context")(function* (sessionID) {
        const fileSession = yield* resolveFileSession(sessionID)
        if (fileSession) {
          const messages = yield* Effect.promise(() => readSessionJsonlMessages(fileSession)).pipe(
            Effect.catchCause(() => Effect.succeed([] as SessionMessage.Message[])),
          )
          return messages
        }
        const stored = yield* SessionHistory.load(db, sessionID)
        return stored
      }),
      runnerEntries,
      runnerContext: Effect.fn("SessionStore.runnerContext")(function* (sessionID, baselineSeq) {
        return (yield* runnerEntries(sessionID, baselineSeq)).map((entry) => entry.message)
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
