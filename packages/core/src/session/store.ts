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
      if (cached) {
        const fileSession = yield* Effect.promise(() => readSessionStore(cached.location.directory, sessionID)).pipe(
          Effect.catchCause(() => Effect.succeed(undefined)),
        )
        if (fileSession) return fileSession
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
      return cached
    })

    return Service.of({
      get: Effect.fn("SessionStore.get")(function* (sessionID) {
        return yield* resolveFileSession(sessionID)
      }),
      context: Effect.fn("SessionStore.context")(function* (sessionID) {
        const stored = yield* SessionHistory.load(db, sessionID)
        if (stored.length > 0) return stored
        const fileSession = yield* resolveFileSession(sessionID)
        if (fileSession) {
          const messages = yield* Effect.promise(() => readSessionJsonlMessages(fileSession)).pipe(
            Effect.catchCause(() => Effect.succeed([] as SessionMessage.Message[])),
          )
          if (messages.length > 0) return messages
        }
        return stored
      }),
      runnerContext: Effect.fn("SessionStore.runnerContext")(function* (sessionID, baselineSeq) {
        return yield* SessionHistory.loadForRunner(db, sessionID, baselineSeq)
      }),
      message: Effect.fn("SessionStore.message")(function* (messageID) {
        const row = yield* db
          .select()
          .from(SessionMessageTable)
          .where(eq(SessionMessageTable.id, messageID))
          .get()
          .pipe(Effect.orDie)
        return row
          ? {
              sessionID: SessionSchema.ID.make(row.session_id),
              message: yield* decodeMessage({ ...row.data, id: row.id, type: row.type }).pipe(Effect.orDie),
            }
          : yield* Effect.gen(function* () {
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
      }),
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Database.defaultLayer))
