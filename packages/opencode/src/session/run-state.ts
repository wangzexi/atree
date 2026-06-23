import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { InstanceState } from "@/effect/instance-state"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Runner } from "@/effect/runner"
import { BackgroundJob } from "@/background/job"
import { Effect, Latch, Layer, Scope, Context } from "effect"
import path from "path"
import { Session } from "./session"
import { SessionID } from "./schema"
import { SessionStatus } from "./status"

export interface Interface {
  readonly assertNotBusy: (sessionID: SessionID, options?: { directory?: string }) => Effect.Effect<void, Session.BusyError>
  readonly cancel: (sessionID: SessionID, options?: { directory?: string }) => Effect.Effect<void>
  readonly ensureRunning: (
    sessionID: SessionID,
    onInterrupt: Effect.Effect<SessionV1.WithParts>,
    work: Effect.Effect<SessionV1.WithParts>,
    options?: { directory?: string },
  ) => Effect.Effect<SessionV1.WithParts>
  readonly startShell: (
    sessionID: SessionID,
    onInterrupt: Effect.Effect<SessionV1.WithParts>,
    work: Effect.Effect<SessionV1.WithParts>,
    ready?: Latch.Latch,
    options?: { directory?: string },
  ) => Effect.Effect<SessionV1.WithParts, Session.BusyError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionRunState") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const background = yield* BackgroundJob.Service
    const status = yield* SessionStatus.Service

    const state = yield* InstanceState.make(
      Effect.fn("SessionRunState.state")(function* () {
        const scope = yield* Scope.Scope
        const runners = new Map<string, Runner.Runner<SessionV1.WithParts>>()
        yield* Effect.addFinalizer(
          Effect.fnUntraced(function* () {
            yield* Effect.forEach(runners.values(), (runner) => runner.cancel, {
              concurrency: "unbounded",
              discard: true,
            })
            runners.clear()
          }),
        )
        return { runners, scope }
      }),
    )

    const key = (sessionID: SessionID, directory?: string) => `${directory ? path.resolve(directory) : ""}\0${sessionID}`
    const keyMatchesSession = (runnerKey: string, sessionID: SessionID) => runnerKey.endsWith(`\0${sessionID}`)

    const runner = Effect.fn("SessionRunState.runner")(function* (
      sessionID: SessionID,
      onInterrupt: Effect.Effect<SessionV1.WithParts>,
      options?: { directory?: string },
    ) {
      const data = yield* InstanceState.get(state)
      const runnerKey = key(sessionID, options?.directory)
      const existing = data.runners.get(runnerKey)
      if (existing) return existing
      const next = Runner.make<SessionV1.WithParts>(data.scope, {
        onIdle: Effect.gen(function* () {
          data.runners.delete(runnerKey)
          yield* status.set(sessionID, { type: "idle" }, { directory: options?.directory })
        }),
        onBusy: status.set(sessionID, { type: "busy" }, { directory: options?.directory }),
        onInterrupt,
      })
      data.runners.set(runnerKey, next)
      return next
    })

    const assertNotBusy = Effect.fn("SessionRunState.assertNotBusy")(function* (
      sessionID: SessionID,
      options?: { directory?: string },
    ) {
      const data = yield* InstanceState.get(state)
      const existing =
        options?.directory !== undefined
          ? data.runners.get(key(sessionID, options.directory))
          : [...data.runners].find(([runnerKey]) => keyMatchesSession(runnerKey, sessionID))?.[1]
      if (existing?.busy) yield* busyError(sessionID)
    })

    const cancel = Effect.fn("SessionRunState.cancel")(function* (
      sessionID: SessionID,
      options?: { directory?: string },
    ) {
      yield* cancelBackgroundJobs(background, sessionID)
      const data = yield* InstanceState.get(state)
      const matching =
        options?.directory !== undefined
          ? [data.runners.get(key(sessionID, options.directory))].filter((runner) => runner !== undefined)
          : [...data.runners].flatMap(([runnerKey, runner]) => (keyMatchesSession(runnerKey, sessionID) ? [runner] : []))
      const existing = matching[0]
      if (!existing) {
        yield* status.set(sessionID, { type: "idle" }, { directory: options?.directory })
        return
      }
      yield* Effect.forEach(matching, (runner) => runner.cancel, { discard: true })
    })

    const ensureRunning = Effect.fn("SessionRunState.ensureRunning")(function* (
      sessionID: SessionID,
      onInterrupt: Effect.Effect<SessionV1.WithParts>,
      work: Effect.Effect<SessionV1.WithParts>,
      options?: { directory?: string },
    ) {
      return yield* (yield* runner(sessionID, onInterrupt, options)).ensureRunning(work)
    })

    const startShell = Effect.fn("SessionRunState.startShell")(function* (
      sessionID: SessionID,
      onInterrupt: Effect.Effect<SessionV1.WithParts>,
      work: Effect.Effect<SessionV1.WithParts>,
      ready?: Latch.Latch,
      options?: { directory?: string },
    ) {
      return yield* (yield* runner(sessionID, onInterrupt, options))
        .startShell(work, ready)
        .pipe(Effect.catchTag("RunnerBusy", () => Effect.fail(busyError(sessionID))))
    })

    return Service.of({ assertNotBusy, cancel, ensureRunning, startShell })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(BackgroundJob.defaultLayer),
  Layer.provide(SessionStatus.defaultLayer),
)

const cancelBackgroundJobs = Effect.fn("SessionRunState.cancelBackgroundJobs")(function* (
  background: BackgroundJob.Interface,
  sessionID: SessionID,
) {
  const jobs = yield* background.list()
  const pending = new Set<string>([sessionID])
  const cancelled = new Set<string>()
  const matches = (job: BackgroundJob.Info) => {
    if (job.status !== "running") return false
    if (cancelled.has(job.id)) return false
    if (pending.has(job.id)) return true
    if (typeof job.metadata?.sessionId === "string" && pending.has(job.metadata.sessionId)) return true
    return typeof job.metadata?.parentSessionId === "string" && pending.has(job.metadata.parentSessionId)
  }
  let batch = jobs.filter(matches)
  while (batch.length > 0) {
    yield* Effect.forEach(
      batch,
      (job) =>
        background.cancel(job.id).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              cancelled.add(job.id)
              pending.add(job.id)
              if (typeof job.metadata?.sessionId === "string") pending.add(job.metadata.sessionId)
            }),
          ),
        ),
      { concurrency: "unbounded", discard: true },
    )
    batch = jobs.filter(matches)
  }
})

function busyError(sessionID: SessionID) {
  return new Session.BusyError({ sessionID })
}

export const node = LayerNode.make(layer, [BackgroundJob.node, SessionStatus.node])

export * as SessionRunState from "./run-state"
