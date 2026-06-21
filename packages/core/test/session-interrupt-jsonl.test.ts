import { expect } from "bun:test"
import path from "path"
import { readFile } from "fs/promises"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { Location } from "@opencode-ai/core/location"
import { ProjectV2 } from "@opencode-ai/core/project"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionStore } from "@opencode-ai/core/session/store"
import { testEffect } from "./lib/effect"
import { tmpdir } from "./fixture/tmpdir"

const database = Database.layerFromPath(":memory:")
const events = EventV2.layer.pipe(Layer.provide(database))
const projects = Layer.succeed(
  ProjectV2.Service,
  ProjectV2.Service.of({
    resolve: (directory) => Effect.succeed({ id: ProjectV2.ID.global, directory }),
    directories: () => Effect.succeed([]),
    commit: () => Effect.void,
  }),
)
const projector = SessionProjector.layer.pipe(Layer.provide(events), Layer.provide(database))
const store = SessionStore.layer.pipe(Layer.provide(database))
const interruptSeqs: Array<number | undefined> = []
const execution = Layer.succeed(
  SessionExecution.Service,
  SessionExecution.Service.of({
    resume: () => Effect.void,
    wake: () => Effect.void,
    interrupt: (_sessionID, seq) =>
      Effect.sync(() => {
        interruptSeqs.push(seq)
      }),
  }),
)
const sessions = SessionV2.layer.pipe(
  Layer.provide(events),
  Layer.provide(database),
  Layer.provide(store),
  Layer.provide(projects),
  Layer.provide(execution),
)
const it = testEffect(Layer.mergeAll(database, events, projects, projector, store, execution, sessions))

it.effect("mirrors interrupt requests into file-backed session jsonl", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()).pipe(Effect.orDie),
    )
    interruptSeqs.length = 0
    const session = yield* (yield* SessionV2.Service).create({
      location: Location.Ref.make({ directory: AbsolutePath.make(tmp.path) }),
    })

    yield* (yield* SessionV2.Service).interrupt(session.id)

    expect(interruptSeqs).toHaveLength(1)
    expect(interruptSeqs[0]).toBeNumber()
    const entries = (
      yield* Effect.promise(() =>
        readFile(path.join(tmp.path, ".agents", "atree", "sessions", session.id, "session.jsonl"), "utf8"),
      )
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(entries.some((entry) => entry.type === "session.next.interrupt.requested")).toBe(true)
  }),
)
