export * as SessionStore from "./store"

import { eq } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { Database } from "../database/database"
import { MessageDecodeError } from "./error"
import { SessionMessage } from "./message"
import { SessionSchema } from "./schema"
import { SessionInputTable } from "./sql"
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
    const resolveFileSession = Effect.fn("SessionStore.resolveFileSession")(function* (
      sessionID: SessionSchema.ID,
      directory?: string,
    ) {
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
      return []
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
          return messages
        }
        return []
      }),
      runnerEntries,
      runnerContext: Effect.fn("SessionStore.runnerContext")(function* (sessionID, baselineSeq, options) {
        return (yield* runnerEntries(sessionID, baselineSeq, options)).map((entry) => entry.message)
      }),
      message: Effect.fn("SessionStore.message")(function* (messageID) {
        const fileMessage = yield* findFileBackedMessage(messageID)
        return fileMessage
      }),
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Database.defaultLayer))
