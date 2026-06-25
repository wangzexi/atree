import { describe, expect } from "bun:test"
import path from "path"
import { readFile } from "fs/promises"
import { Context, DateTime, Deferred, Effect, Exit, Fiber, Layer, Scope } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { Location } from "@opencode-ai/core/location"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { QuestionV2 } from "@opencode-ai/core/question"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionStore } from "@opencode-ai/core/session/store"
import { appendSessionJsonl, writeSessionStore } from "@opencode-ai/core/atree/session-store"
import { readQuestionStateEntries } from "@opencode-ai/core/atree/question-store"
import { testEffect } from "./lib/effect"
import { tmpdir } from "./fixture/tmpdir"

const database = Database.layerFromPath(":memory:")
const events = EventV2.layer.pipe(Layer.provide(database))
const store = SessionStore.layer.pipe(Layer.provide(database))
const current = Layer.succeed(
  Location.Service,
  Location.Service.of({
    directory: AbsolutePath.make("/project"),
    project: { id: ProjectV2.ID.global, directory: AbsolutePath.make("/project") },
    vcs: undefined,
  }),
)
const questions = QuestionV2.layer.pipe(Layer.provide(events), Layer.provide(store), Layer.provide(current))
const it = testEffect(Layer.mergeAll(database, events, store, current, questions))

const sessionID = SessionV2.ID.make("ses_question_test")
const question: QuestionV2.Info = {
  question: "Which option?",
  header: "Option",
  options: [{ label: "One", description: "First option" }],
}

const waitForAsk = Effect.fn("QuestionV2Test.waitForAsk")(function* (
  service: QuestionV2.Interface,
  input: QuestionV2.AskInput,
) {
  const events = yield* EventV2.Service
  const asked = yield* Deferred.make<QuestionV2.Request>()
  const unsubscribe = yield* events.listen((event) =>
    event.type === QuestionV2.Event.Asked.type
      ? Deferred.succeed(asked, event.data as QuestionV2.Request).pipe(Effect.asVoid)
      : Effect.void,
  )
  yield* Effect.addFinalizer(() => unsubscribe)
  const fiber = yield* service.ask(input).pipe(Effect.forkScoped)
  return { fiber, request: yield* Deferred.await(asked) }
})

describe("QuestionV2", () => {
  it.effect("publishes lifecycle events and settles a pending reply", () =>
    Effect.gen(function* () {
      const service = yield* QuestionV2.Service
      const events = yield* EventV2.Service
      const published: EventV2.Payload[] = []
      const unsubscribe = yield* events.listen((event) =>
        Effect.sync(() => {
          if (event.type.startsWith("question.v2.")) published.push(event)
        }),
      )
      yield* Effect.addFinalizer(() => unsubscribe)
      const { fiber, request } = yield* waitForAsk(service, { sessionID, questions: [question] })

      expect(request.id).toMatch(/^que_/)
      expect(yield* service.list()).toEqual([request])
      yield* service.reply({ requestID: request.id, answers: [["One"]] })

      expect(yield* Fiber.join(fiber)).toEqual([["One"]])
      expect(yield* service.list()).toEqual([])
      expect(published.map((event) => [event.type, event.data])).toEqual([
        [QuestionV2.Event.Asked.type, request],
        [QuestionV2.Event.Replied.type, { sessionID, requestID: request.id, answers: [["One"]] }],
      ])
    }),
  )

  it.effect("mirrors question lifecycle into file-backed session jsonl", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()).pipe(Effect.orDie),
      )
      const directory = AbsolutePath.make(tmp.path)
      const fileSessionID = SessionV2.ID.make("ses_question_jsonl")
      const session = SessionV2.Info.make({
        id: fileSessionID,
        projectID: ProjectV2.ID.global,
        title: "Question jsonl",
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: DateTime.makeUnsafe(1), updated: DateTime.makeUnsafe(1) },
        location: Location.Ref.make({ directory }),
      })
      yield* Effect.promise(() => writeSessionStore(session))
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: ProjectV2.ID.global, worktree: directory, sandboxes: [] })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: fileSessionID,
          project_id: ProjectV2.ID.global,
          slug: "question-jsonl",
          directory,
          title: "Question jsonl",
          version: "core",
        })
        .run()
        .pipe(Effect.orDie)

      const service = yield* QuestionV2.Service
      const { fiber, request } = yield* waitForAsk(service, {
        sessionID: fileSessionID,
        directory,
        questions: [question],
      })
      yield* service.reply({ requestID: request.id, answers: [["One"]] })
      expect(yield* Fiber.join(fiber)).toEqual([["One"]])

      const entries = (
        yield* Effect.promise(() =>
          readFile(path.join(tmp.path, ".agents", "atree", "sessions", fileSessionID, "session.jsonl"), "utf8"),
        )
      )
        .trim()
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
      expect(
        entries.some((entry) => {
          const data = typeof entry.data === "object" && entry.data !== null ? (entry.data as Record<string, unknown>) : entry
          return entry.type === QuestionV2.Event.Asked.type && data.id === request.id
        }),
      ).toBe(true)
      expect(
        entries.some((entry) => {
          const data = typeof entry.data === "object" && entry.data !== null ? (entry.data as Record<string, unknown>) : entry
          return entry.type === QuestionV2.Event.Replied.type && data.requestID === request.id
        }),
      ).toBe(true)
    }),
  )

  it.effect("publishes rejection, fails the ask, and rejects unknown IDs", () =>
    Effect.gen(function* () {
      const service = yield* QuestionV2.Service
      const events = yield* EventV2.Service
      const published: EventV2.Payload[] = []
      const unsubscribe = yield* events.listen((event) =>
        Effect.sync(() => {
          if (event.type === QuestionV2.Event.Rejected.type) published.push(event)
        }),
      )
      yield* Effect.addFinalizer(() => unsubscribe)
      const { fiber, request } = yield* waitForAsk(service, { sessionID, questions: [question] })

      yield* service.reject(request.id)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(exit.cause.toString()).toContain("QuestionV2.RejectedError")
      expect(published.map((event) => event.data)).toEqual([{ sessionID, requestID: request.id }])

      const unknown = QuestionV2.ID.ascending("que_unknown")
      expect(yield* service.reply({ requestID: unknown, answers: [] }).pipe(Effect.flip)).toEqual(
        new QuestionV2.NotFoundError({ requestID: unknown }),
      )
      expect(yield* service.reject(unknown).pipe(Effect.flip)).toEqual(
        new QuestionV2.NotFoundError({ requestID: unknown }),
      )
    }),
  )

  it.effect("isolates pending requests by location-layer instance and rejects them on finalization", () =>
    Effect.gen(function* () {
      const firstScope = yield* Scope.make()
      const secondScope = yield* Scope.make()
      const first = Context.get(yield* Layer.buildWithScope(Layer.fresh(questions), firstScope), QuestionV2.Service)
      const second = Context.get(yield* Layer.buildWithScope(Layer.fresh(questions), secondScope), QuestionV2.Service)
      const fiber = yield* first.ask({ sessionID, questions: [question] }).pipe(Effect.forkScoped)
      yield* Effect.yieldNow
      const request = (yield* first.list())[0]!

      expect(yield* second.list()).toEqual([])
      expect(yield* second.reply({ requestID: request.id, answers: [["One"]] }).pipe(Effect.flip)).toEqual(
        new QuestionV2.NotFoundError({ requestID: request.id }),
      )

      yield* Scope.close(firstScope, Exit.void)
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(exit.cause.toString()).toContain("QuestionV2.RejectedError")
      yield* Scope.close(secondScope, Exit.void)
    }),
  )

  it.effect("does not restore ambiguous copied pending questions across directories", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()).pipe(Effect.orDie),
      )
      const source = AbsolutePath.make(path.join(tmp.path, "source"))
      const target = AbsolutePath.make(path.join(tmp.path, "target"))
      const copiedSessionID = SessionV2.ID.make("ses_question_copied")
      const requestID = QuestionV2.ID.ascending("que_copied")

      const writeSession = (directory: AbsolutePath, title: string) =>
        writeSessionStore(
          SessionV2.Info.make({
            id: copiedSessionID,
            projectID: ProjectV2.ID.global,
            title,
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: DateTime.makeUnsafe(1), updated: DateTime.makeUnsafe(1) },
            location: Location.Ref.make({ directory }),
          }),
        )

      yield* Effect.promise(() => writeSession(source, "Question source"))
      yield* Effect.promise(() => writeSession(target, "Question target"))

      const request: QuestionV2.Request = {
        id: requestID,
        sessionID: copiedSessionID,
        questions: [question],
      }

      yield* Effect.promise(() =>
        appendSessionJsonl(
          SessionV2.Info.make({
            id: copiedSessionID,
            projectID: ProjectV2.ID.global,
            title: "Question source",
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: DateTime.makeUnsafe(1), updated: DateTime.makeUnsafe(1) },
            location: Location.Ref.make({ directory: source }),
          }),
          { type: QuestionV2.Event.Asked.type, ...request },
        ),
      )
      yield* Effect.promise(() =>
        appendSessionJsonl(
          SessionV2.Info.make({
            id: copiedSessionID,
            projectID: ProjectV2.ID.global,
            title: "Question target",
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: DateTime.makeUnsafe(1), updated: DateTime.makeUnsafe(1) },
            location: Location.Ref.make({ directory: target }),
          }),
          { type: QuestionV2.Event.Asked.type, ...request },
        ),
      )

      expect(yield* Effect.promise(() => readQuestionStateEntries(tmp.path))).toEqual([])
    }),
  )
})
