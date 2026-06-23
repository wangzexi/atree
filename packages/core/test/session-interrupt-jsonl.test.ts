import { expect } from "bun:test"
import path from "path"
import { mkdir, readFile, writeFile } from "fs/promises"
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
const executionCalls: SessionV2.ID[] = []
const interruptSeqs: Array<number | undefined> = []
const execution = Layer.succeed(
  SessionExecution.Service,
  SessionExecution.Service.of({
    resume: (sessionID) =>
      Effect.sync(() => {
        executionCalls.push(sessionID)
      }),
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

function writePureFileSession(directory: string, sessionID: SessionV2.ID) {
  const sessionRoot = path.join(directory, ".agents", "atree", "sessions", sessionID)
  return Effect.promise(async () => {
    await mkdir(sessionRoot, { recursive: true })
    await writeFile(
      path.join(sessionRoot, "meta.yaml"),
      [
        "version: 1",
        `id: ${JSON.stringify(sessionID)}`,
        `slug: ${JSON.stringify(sessionID)}`,
        `sessionVersion: "test"`,
        `projectID: "global"`,
        `workspaceID: null`,
        `path: "."`,
        `parentID: null`,
        `title: "Pure file session"`,
        `agent: null`,
        `model: null`,
        `createdAt: 10`,
        `updatedAt: 20`,
        `archivedAt: null`,
        `cost: 0`,
        `tokens: {"input":0,"output":0,"reasoning":0,"cache":{"read":0,"write":0}}`,
        `metadata: {}`,
        "",
      ].join("\n"),
    )
    return sessionRoot
  })
}

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

it.effect("records interrupt requests for pure file-backed sessions without SQLite rows", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()).pipe(Effect.orDie),
    )
    interruptSeqs.length = 0
    const sessionID = SessionV2.ID.make("ses_file_interrupt_only")
    const sessionRoot = yield* writePureFileSession(tmp.path, sessionID)

    yield* (yield* SessionV2.Service).interrupt(sessionID, { directory: AbsolutePath.make(tmp.path) })

    expect(interruptSeqs).toEqual([undefined])
    const entries = (
      yield* Effect.promise(() => readFile(path.join(sessionRoot, "session.jsonl"), "utf8"))
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(entries).toContainEqual(
      expect.objectContaining({
        type: "session.next.interrupt.requested",
        sessionID,
      }),
    )
  }),
)

it.effect("resumes pure file-backed sessions through an explicit directory", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()).pipe(Effect.orDie),
    )
    executionCalls.length = 0
    const sessionID = SessionV2.ID.make("ses_file_resume_only")
    yield* writePureFileSession(tmp.path, sessionID)

    yield* (yield* SessionV2.Service).resume(sessionID, { directory: AbsolutePath.make(tmp.path) })

    expect(executionCalls).toEqual([sessionID])
  }),
)
