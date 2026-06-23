import { describe, expect } from "bun:test"
import { Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { BackgroundJob } from "../../src/background/job"
import { SessionID } from "../../src/session/schema"
import { SessionRunState } from "../../src/session/run-state"
import { SessionStatus } from "../../src/session/status"
import { testEffect } from "../lib/effect"

const status = SessionStatus.defaultLayer
const runState = SessionRunState.layer.pipe(Layer.provide(BackgroundJob.defaultLayer), Layer.provide(status))
const it = testEffect(Layer.mergeAll(status, runState))

const sessionID = SessionID.make("ses_status_directory")
const source = "/tmp/atree-status-source"
const target = "/tmp/atree-status-target"

describe("directory-scoped session status", () => {
  it.effect("keeps copied session statuses isolated by directory", () =>
    Effect.gen(function* () {
      const status = yield* SessionStatus.Service

      yield* status.set(sessionID, { type: "busy" }, { directory: source })

      expect(yield* status.get(sessionID, { directory: source })).toEqual({ type: "busy" })
      expect(yield* status.get(sessionID, { directory: target })).toEqual({ type: "idle" })
      expect(yield* status.get(sessionID)).toEqual({ type: "busy" })
    }),
  )

  it.instance("keeps copied session runners isolated by directory", () =>
    Effect.gen(function* () {
      const run = yield* SessionRunState.Service
      const started = yield* Deferred.make<void>()

      const fiber = yield* run
        .ensureRunning(
          sessionID,
          Effect.succeed({} as never),
          Effect.gen(function* () {
            yield* Deferred.succeed(started, undefined)
            return yield* Effect.never
          }),
          { directory: source },
        )
        .pipe(Effect.forkChild)
      yield* Deferred.await(started)

      expect(Exit.isFailure(yield* run.assertNotBusy(sessionID, { directory: source }).pipe(Effect.exit))).toBe(true)
      expect(Exit.isSuccess(yield* run.assertNotBusy(sessionID, { directory: target }).pipe(Effect.exit))).toBe(true)

      yield* run.cancel(sessionID, { directory: source })
      yield* Fiber.await(fiber)
      expect(yield* (yield* SessionStatus.Service).get(sessionID, { directory: source })).toEqual({ type: "idle" })
    }),
  )
})
