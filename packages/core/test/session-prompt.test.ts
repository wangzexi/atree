import { describe, expect } from "bun:test"
import path from "path"
import { mkdir, readFile, writeFile } from "fs/promises"
import { Effect, Layer, Stream } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { ProjectV2 } from "@opencode-ai/core/project"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { Prompt } from "@opencode-ai/core/session/prompt"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SessionInputTable, SessionMessageTable, SessionTable } from "@opencode-ai/core/session/sql"
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
const executionDirectories: Array<string | undefined> = []
const interruptCalls: SessionV2.ID[] = []
const interruptSeqs: Array<number | undefined> = []
const interruptDirectories: Array<string | undefined> = []
const wakeCalls: SessionV2.ID[] = []
const wakeSeqs: Array<number | undefined> = []
const execution = Layer.succeed(
  SessionExecution.Service,
  SessionExecution.Service.of({
    resume: (sessionID, options) =>
      Effect.sync(() => {
        executionCalls.push(sessionID)
        executionDirectories.push(options?.directory)
      }),
    wake: (sessionID, seq, options) =>
      Effect.sync(() => {
        wakeCalls.push(sessionID)
        wakeSeqs.push(seq)
        executionDirectories.push(options?.directory)
      }),
    interrupt: (sessionID, seq, options) =>
      Effect.sync(() => {
        interruptCalls.push(sessionID)
        interruptSeqs.push(seq)
        interruptDirectories.push(options?.directory)
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

function readSessionJsonl(directory: string, sessionID: SessionV2.ID) {
  return readFile(path.join(directory, ".agents", "atree", "sessions", sessionID, "session.jsonl"), "utf8")
}

describe("SessionV2.prompt", () => {
  it.effect("delegates execution continuation through SessionExecution for a file-backed session", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()).pipe(Effect.orDie),
      )
      const sessionID = SessionV2.ID.make("ses_prompt_resume")
      yield* writePureFileSession(tmp.path, sessionID)
      executionCalls.length = 0
      executionDirectories.length = 0

      yield* (yield* SessionV2.Service).resume(sessionID, { directory: AbsolutePath.make(tmp.path) })

      expect(executionCalls).toEqual([sessionID])
      expect(executionDirectories).toEqual([path.resolve(tmp.path)])
    }),
  )

  it.effect("delegates interruption through SessionExecution for a file-backed session", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()).pipe(Effect.orDie),
      )
      const sessionID = SessionV2.ID.make("ses_prompt_interrupt")
      yield* writePureFileSession(tmp.path, sessionID)
      interruptCalls.length = 0
      interruptSeqs.length = 0
      interruptDirectories.length = 0

      yield* (yield* SessionV2.Service).interrupt(sessionID, { directory: AbsolutePath.make(tmp.path) })

      expect(interruptCalls).toEqual([sessionID])
      expect(interruptSeqs).toEqual([undefined])
      expect(interruptDirectories).toEqual([path.resolve(tmp.path)])
    }),
  )

  it.effect("records a prompt into file-backed session jsonl without reviving SQLite projections", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()).pipe(Effect.orDie),
      )
      const sessionID = SessionV2.ID.make("ses_prompt_file")
      const messageID = SessionMessage.ID.make("msg_prompt_file")
      yield* writePureFileSession(tmp.path, sessionID)
      const session = yield* SessionV2.Service
      const { db } = yield* Database.Service

      const admitted = yield* session.prompt({
        sessionID,
        id: messageID,
        prompt: new Prompt({ text: "record this prompt" }),
        resume: false,
        directory: AbsolutePath.make(tmp.path),
      })

      expect(admitted).toMatchObject({ id: messageID, sessionID, prompt: { text: "record this prompt" } })
      expect(yield* session.messages({ sessionID, directory: AbsolutePath.make(tmp.path) })).toMatchObject([
        { id: messageID, type: "user", text: "record this prompt" },
      ])
      expect(
        yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie),
      ).toBeUndefined()
      expect(
        yield* db.select().from(SessionInputTable).where(eq(SessionInputTable.id, messageID)).get().pipe(Effect.orDie),
      ).toBeUndefined()
      expect(
        yield* db.select().from(SessionMessageTable).where(eq(SessionMessageTable.id, messageID)).get().pipe(Effect.orDie),
      ).toBeUndefined()
    }),
  )

  it.effect("reads durable prompt lifecycle events from a file-backed session after they are recorded", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()).pipe(Effect.orDie),
      )
      const sessionID = SessionV2.ID.make("ses_prompt_stream")
      yield* writePureFileSession(tmp.path, sessionID)
      const session = yield* SessionV2.Service

      yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "First" }),
        resume: false,
        directory: AbsolutePath.make(tmp.path),
      })
      yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "Second" }),
        resume: false,
        directory: AbsolutePath.make(tmp.path),
      })

      const streamed = Array.from(
        yield* session.events({ sessionID, directory: AbsolutePath.make(tmp.path) }).pipe(Stream.runCollect),
      )
      expect(streamed.map((item) => item.event.type)).toEqual([
        SessionEvent.PromptLifecycle.Admitted.type,
        SessionEvent.PromptLifecycle.Admitted.type,
      ])
      expect(
        Array.from(
          yield* session
            .events({ sessionID, directory: AbsolutePath.make(tmp.path), after: streamed[0]!.cursor })
            .pipe(Stream.take(1), Stream.runCollect),
        ).map((item) => item.event.type),
      ).toEqual([SessionEvent.PromptLifecycle.Admitted.type])
    }),
  )

  it.effect("returns the original prompt admission when the message ID is retried exactly", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()).pipe(Effect.orDie),
      )
      const sessionID = SessionV2.ID.make("ses_prompt_retry")
      const messageID = SessionMessage.ID.make("msg_prompt_retry")
      yield* writePureFileSession(tmp.path, sessionID)
      const session = yield* SessionV2.Service

      const first = yield* session.prompt({
        sessionID,
        id: messageID,
        prompt: new Prompt({ text: "retry me" }),
        resume: false,
        directory: AbsolutePath.make(tmp.path),
      })
      const before = yield* Effect.promise(() => readSessionJsonl(tmp.path, sessionID))
      const retried = yield* session.prompt({
        sessionID,
        id: messageID,
        prompt: new Prompt({ text: "retry me" }),
        resume: false,
        directory: AbsolutePath.make(tmp.path),
      })
      const after = yield* Effect.promise(() => readSessionJsonl(tmp.path, sessionID))

      expect(retried.id).toBe(first.id)
      expect(retried.prompt.text).toBe(first.prompt.text)
      expect(after).toBe(before)
    }),
  )

  it.effect("rejects reuse of one message ID with a different prompt in a file-backed session", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()).pipe(Effect.orDie),
      )
      const sessionID = SessionV2.ID.make("ses_prompt_conflict")
      const messageID = SessionMessage.ID.make("msg_prompt_conflict")
      yield* writePureFileSession(tmp.path, sessionID)
      const session = yield* SessionV2.Service

      yield* session.prompt({
        sessionID,
        id: messageID,
        prompt: new Prompt({ text: "same id" }),
        resume: false,
        directory: AbsolutePath.make(tmp.path),
      })
      const failure = yield* session
        .prompt({
          sessionID,
          id: messageID,
          prompt: new Prompt({ text: "different text" }),
          resume: false,
          directory: AbsolutePath.make(tmp.path),
        })
        .pipe(Effect.flip)

      expect(failure._tag).toBe("Session.PromptConflictError")
    }),
  )

  it.effect("wakes execution by default and stays idle when resume is false", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()).pipe(Effect.orDie),
      )
      const sessionID = SessionV2.ID.make("ses_prompt_wake")
      yield* writePureFileSession(tmp.path, sessionID)
      const session = yield* SessionV2.Service
      wakeCalls.length = 0
      wakeSeqs.length = 0
      executionDirectories.length = 0

      const admitted = yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "wake me" }),
        directory: AbsolutePath.make(tmp.path),
      })

      expect(wakeCalls).toEqual([sessionID])
      expect(wakeSeqs).toEqual([admitted.admittedSeq])
      expect(executionDirectories).toEqual([path.resolve(tmp.path)])

      wakeCalls.length = 0
      wakeSeqs.length = 0
      executionDirectories.length = 0

      yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "record only" }),
        resume: false,
        directory: AbsolutePath.make(tmp.path),
      })

      expect(wakeCalls).toEqual([])
      expect(wakeSeqs).toEqual([])
      expect(executionDirectories).toEqual([])
    }),
  )
})
