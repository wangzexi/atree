export * as SessionStore from "./store"

import { Context, Effect, Layer } from "effect"
import { MessageDecodeError } from "./error"
import { SessionInput } from "./input"
import { SessionMessage } from "./message"
import { SessionSchema } from "./schema"
import {
  findSessionJsonlMessage,
  findSessionStore,
  promoteSessionPrompts,
  readSessionPromptStates,
  readSessionJsonlMessages,
  readSessionStore,
  readSessionStores,
  readWorkspaceRoot,
  readWorkspaceSessionStoresDeep,
} from "../atree/session-store"

export interface Interface {
  readonly list: (options?: { directory?: string }) => Effect.Effect<SessionSchema.Info[]>
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
  readonly hasPendingInput: (
    sessionID: SessionSchema.ID,
    delivery: SessionInput.Delivery,
    options?: { directory?: string },
  ) => Effect.Effect<boolean | undefined>
  readonly promoteInputs: (
    sessionID: SessionSchema.ID,
    input: {
      readonly delivery: SessionInput.Delivery
      readonly mode: "all" | "next"
      readonly cutoff?: number
    },
    options?: { directory?: string },
  ) => Effect.Effect<number | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/SessionStore") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const resolveFileSession = Effect.fn("SessionStore.resolveFileSession")(function* (
      sessionID: SessionSchema.ID,
      directory?: string,
    ) {
      if (directory) {
        const fileSession = yield* Effect.promise(() => readSessionStore(directory, sessionID)).pipe(
          Effect.catchCause(() => Effect.succeed(undefined)),
        )
        if (fileSession) return fileSession
        return yield* Effect.promise(() => findSessionStore(directory, sessionID)).pipe(
          Effect.catchCause(() => Effect.succeed(undefined)),
        )
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

    const list = Effect.fn("SessionStore.list")(function* (options?: { directory?: string }) {
      const directory = options?.directory
      if (directory) {
        return yield* Effect.promise(() => readSessionStores(directory)).pipe(
          Effect.catchCause(() => Effect.succeed([] as SessionSchema.Info[])),
        )
      }
      return yield* Effect.promise(() => readWorkspaceSessionStoresDeep()).pipe(
        Effect.catchCause(() => Effect.succeed([] as SessionSchema.Info[])),
      )
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
        const promptStates = yield* Effect.promise(() => readSessionPromptStates(fileSession)).pipe(
          Effect.catchCause(() => Effect.succeed(new Map())),
        )
        return messages
          .map((message, index) => ({ seq: index + 1, message }))
          .filter((entry) => {
            if (entry.message.type !== "user") return true
            return promptStates.get(entry.message.id)?.status !== "admitted"
          })
          .filter((entry) => entry.message.type !== "system" || entry.seq > baselineSeq)
      }
      return []
    })

    return Service.of({
      list,
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
      hasPendingInput: Effect.fn("SessionStore.hasPendingInput")(function* (sessionID, delivery, options) {
        const fileSession = yield* resolveFileSession(sessionID, options?.directory)
        if (!fileSession) return undefined
        const states = yield* Effect.promise(() => readSessionPromptStates(fileSession)).pipe(
          Effect.catchCause(() => Effect.succeed(new Map())),
        )
        return [...states.values()].some((state) => state.status === "admitted" && state.delivery === delivery)
      }),
      promoteInputs: Effect.fn("SessionStore.promoteInputs")(function* (sessionID, input, options) {
        const fileSession = yield* resolveFileSession(sessionID, options?.directory)
        if (!fileSession) return undefined
        return yield* Effect.promise(() => promoteSessionPrompts(fileSession, input))
      }),
    })
  }),
)

export const defaultLayer = layer
