import { Effect, Layer } from "effect"
import path from "path"
import { LocationServiceMap } from "../../location-layer"
import { SessionRunCoordinator } from "../run-coordinator"
import { SessionRunner } from "../runner"
import { SessionSchema } from "../schema"
import { SessionStore } from "../store"
import { SessionExecution } from "../execution"
import { logFailure } from "../logging"

function targetKey(sessionID: SessionSchema.ID, directory?: string) {
  return `${directory ? path.resolve(directory) : ""}\0${sessionID}`
}

function targetFromKey(key: string) {
  const marker = key.indexOf("\0")
  return {
    directory: marker > 0 ? key.slice(0, marker) : undefined,
    sessionID: SessionSchema.ID.make(key.slice(marker + 1)),
  }
}

/** Current-process routing for implicit-local Locations. Future remote placement belongs here. */
export const layer = Layer.effect(
  SessionExecution.Service,
  Effect.gen(function* () {
    const store = yield* SessionStore.Service
    const locations = yield* LocationServiceMap
    const coordinator = yield* SessionRunCoordinator.make<string, void, SessionRunner.RunError>({
      drain: Effect.fnUntraced(function* (key: string, mode) {
        const target = targetFromKey(key)
        const session = yield* store.get(target.sessionID, { directory: target.directory })
        const sessionID = target.sessionID
        if (!session) return yield* Effect.die(`Session not found: ${sessionID}`)
        return yield* SessionRunner.Service.use((runner) => runner.run({ sessionID, force: mode === "run" })).pipe(
          Effect.provide(locations.get(session.location)),
        )
      }),
      onFailure: (key, cause) => logFailure("Failed to drain Session", targetFromKey(key).sessionID, cause),
    })

    return SessionExecution.Service.of({
      interrupt: (sessionID, seq, options) => coordinator.interrupt(targetKey(sessionID, options?.directory), seq),
      resume: (sessionID, options) => coordinator.run(targetKey(sessionID, options?.directory)),
      wake: (sessionID, seq, options) => coordinator.wake(targetKey(sessionID, options?.directory), seq),
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(SessionStore.defaultLayer))
