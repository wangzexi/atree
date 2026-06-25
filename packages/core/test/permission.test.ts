import { describe, expect } from "bun:test"
import path from "path"
import { readFile } from "fs/promises"
import { DateTime, Deferred, Effect, Fiber, Layer } from "effect"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { Location } from "@opencode-ai/core/location"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { PermissionTable } from "@opencode-ai/core/permission/sql"
import { PermissionSaved } from "@opencode-ai/core/permission/saved"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionStore } from "@opencode-ai/core/session/store"
import { appendSessionJsonl, writeSessionStore } from "@opencode-ai/core/atree/session-store"
import { readPermissionStateEntries } from "@opencode-ai/core/atree/permission-store"
import { eq } from "drizzle-orm"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"
import { tmpdir } from "./fixture/tmpdir"

const database = Database.layerFromPath(":memory:")
const current = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make("/project") })),
)
const events = EventV2.layer.pipe(Layer.provide(database))
const store = SessionStore.layer.pipe(Layer.provide(database))
const sessions = SessionV2.layer.pipe(
  Layer.provide(events),
  Layer.provide(database),
  Layer.provide(store),
  Layer.provide(Project.defaultLayer),
  Layer.provide(SessionExecution.noopLayer),
)
const saved = PermissionSaved.layer.pipe(Layer.provide(database))
const layer = PermissionV2.locationLayer.pipe(
  Layer.provideMerge(database),
  Layer.provideMerge(store),
  Layer.provideMerge(events),
  Layer.provideMerge(current),
  Layer.provideMerge(sessions),
  Layer.provideMerge(SessionExecution.noopLayer),
  Layer.provideMerge(saved),
)
const it = testEffect(layer)

function setup(rules: PermissionV2.Ruleset = []) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: SessionV2.ID.make("ses_test"),
        project_id: Project.ID.global,
        slug: "test",
        directory: "/project",
        title: "test",
        version: "test",
        agent: "test",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* setRules(rules)
  })
}

function setRules(rules: PermissionV2.Ruleset) {
  return Effect.gen(function* () {
    const agents = yield* AgentV2.Service
    const update = yield* agents.transform()
    yield* update((editor) =>
      editor.update(AgentV2.ID.make("test"), (agent) => {
        agent.permissions = [...rules]
      }),
    )
  })
}

function assertion(input: Partial<PermissionV2.AssertInput> = {}) {
  return {
    id: PermissionV2.ID.create("per_test"),
    sessionID: SessionV2.ID.make("ses_test"),
    action: "read",
    resources: ["src/index.ts"],
    ...input,
  } satisfies PermissionV2.AssertInput
}

function waitForRequest() {
  return Effect.gen(function* () {
    const service = yield* PermissionV2.Service
    const events = yield* EventV2.Service
    const asked = yield* Deferred.make<PermissionV2.Request>()
    const unsubscribe = yield* events.listen((event) =>
      event.type === PermissionV2.Event.Asked.type
        ? Deferred.succeed(asked, event.data as PermissionV2.Request).pipe(Effect.asVoid)
        : Effect.void,
    )
    yield* Effect.addFinalizer(() => unsubscribe)
    const fiber = yield* service.assert(assertion()).pipe(Effect.forkScoped)
    const request = yield* Deferred.await(asked)
    return { service, fiber, request }
  })
}

describe("PermissionV2", () => {
  it.effect("returns the evaluated effect and only queues prompts", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "read", resource: "*", effect: "allow" }])
      const service = yield* PermissionV2.Service
      expect(yield* service.ask(assertion())).toEqual({ id: PermissionV2.ID.create("per_test"), effect: "allow" })
      expect(yield* service.list()).toEqual([])
      yield* setRules([{ action: "read", resource: "*", effect: "deny" }])
      expect(yield* service.ask(assertion())).toEqual({ id: PermissionV2.ID.create("per_test"), effect: "deny" })
      expect(yield* service.list()).toEqual([])
      yield* setRules([])
      expect(yield* service.ask(assertion())).toEqual({ id: PermissionV2.ID.create("per_test"), effect: "ask" })
      expect(yield* service.get(PermissionV2.ID.create("per_test"))).toBeDefined()
    }),
  )

  it.effect("mirrors permission lifecycle into file-backed session jsonl", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()).pipe(Effect.orDie),
      )
      const directory = AbsolutePath.make(tmp.path)
      const sessionID = SessionV2.ID.make("ses_permission_jsonl")
      const session = SessionV2.Info.make({
        id: sessionID,
        projectID: Project.ID.global,
        title: "Permission jsonl",
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: DateTime.makeUnsafe(1), updated: DateTime.makeUnsafe(1) },
        location: Location.Ref.make({ directory }),
        agent: AgentV2.ID.make("test"),
      })
      yield* Effect.promise(() => writeSessionStore(session))
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: directory, sandboxes: [] })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "permission-jsonl",
          directory,
          title: "Permission jsonl",
          version: "core",
          agent: "test",
        })
        .run()
        .pipe(Effect.orDie)
      yield* setRules([])

      const service = yield* PermissionV2.Service
      const events = yield* EventV2.Service
      const asked = yield* Deferred.make<PermissionV2.Request>()
      const unsubscribe = yield* events.listen((event) =>
        event.type === PermissionV2.Event.Asked.type
          ? Deferred.succeed(asked, event.data as PermissionV2.Request).pipe(Effect.asVoid)
          : Effect.void,
      )
      yield* Effect.addFinalizer(() => unsubscribe)
      const fiber = yield* service
        .assert(assertion({ id: PermissionV2.ID.create("per_jsonl"), sessionID, directory }))
        .pipe(Effect.forkScoped)
      const request = yield* Deferred.await(asked)
      expect(request.id).toBe(PermissionV2.ID.create("per_jsonl"))
      yield* service.reply({ requestID: request.id, reply: "once" })
      yield* Fiber.join(fiber)

      const entries = (
        yield* Effect.promise(() =>
          readFile(path.join(tmp.path, ".agents", "atree", "sessions", sessionID, "session.jsonl"), "utf8"),
        )
      )
        .trim()
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
      expect(
        entries.some((entry) => {
          const data = typeof entry.data === "object" && entry.data !== null ? (entry.data as Record<string, unknown>) : entry
          return entry.type === PermissionV2.Event.Asked.type && data.id === request.id
        }),
      ).toBe(true)
      expect(
        entries.some((entry) => {
          const data = typeof entry.data === "object" && entry.data !== null ? (entry.data as Record<string, unknown>) : entry
          return entry.type === PermissionV2.Event.Replied.type && data.requestID === request.id
        }),
      ).toBe(true)
    }),
  )

  it.effect("evaluates against an explicit provider-turn agent", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "read", resource: "*", effect: "allow" }])
      const agents = yield* AgentV2.Service
      yield* agents.update((editor) =>
        editor.update(AgentV2.ID.make("reviewer"), (agent) => {
          agent.permissions.push({ action: "read", resource: "*", effect: "deny" })
        }),
      )
      const service = yield* PermissionV2.Service

      expect(yield* service.ask(assertion())).toMatchObject({ effect: "allow" })
      expect(yield* service.ask(assertion({ agent: AgentV2.ID.make("reviewer") }))).toMatchObject({ effect: "deny" })
      yield* agents.update((editor) =>
        editor.update(AgentV2.ID.make("reviewer"), (agent) => {
          agent.permissions = []
        }),
      )
      expect(yield* service.ask(assertion({ agent: AgentV2.ID.make("reviewer") }))).toMatchObject({ effect: "ask" })
      expect(yield* service.get(PermissionV2.ID.create("per_test"))).not.toHaveProperty("agent")
    }),
  )

  it.effect("allows and denies from explicit rules without asking", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "read", resource: "*", effect: "allow" }])
      const service = yield* PermissionV2.Service
      yield* service.assert(assertion())
      yield* setRules([{ action: "read", resource: "*", effect: "deny" }])
      const denied = yield* service.assert(assertion()).pipe(Effect.flip)
      expect(denied).toBeInstanceOf(PermissionV2.DeniedError)
      expect(yield* service.list()).toEqual([])
    }),
  )

  it.effect("allows managed output reads without granting external directory access", () =>
    Effect.gen(function* () {
      yield* setup([
        { action: "*", resource: "*", effect: "deny" },
        { action: "read", resource: "*", effect: "allow" },
      ])
      const service = yield* PermissionV2.Service

      expect(yield* service.ask(assertion({ resources: ["tool_123"] }))).toMatchObject({ effect: "allow" })
      expect(
        yield* service.ask(assertion({ action: "external_directory", resources: ["/tmp/tool-output/*"] })),
      ).toMatchObject({ effect: "deny" })
    }),
  )

  it.effect("uses build permissions when the Session agent is omitted", () =>
    Effect.gen(function* () {
      yield* setup()
      const { db } = yield* Database.Service
      yield* db
        .update(SessionTable)
        .set({ agent: null })
        .where(eq(SessionTable.id, SessionV2.ID.make("ses_test")))
        .run()
        .pipe(Effect.orDie)
      const agents = yield* AgentV2.Service
      const update = yield* agents.transform()
      yield* update((editor) =>
        editor.update(AgentV2.ID.make("build"), (agent) => {
          agent.permissions = [{ action: "todowrite", resource: "*", effect: "allow" }]
        }),
      )

      const service = yield* PermissionV2.Service
      expect(yield* service.ask(assertion({ action: "todowrite", resources: ["*"] }))).toEqual({
        id: PermissionV2.ID.create("per_test"),
        effect: "allow",
      })
      expect(yield* service.list()).toEqual([])
    }),
  )

  it.effect("denies omitted-agent permissions when no primary default agent exists", () =>
    Effect.gen(function* () {
      yield* setup()
      const { db } = yield* Database.Service
      yield* db
        .update(SessionTable)
        .set({ agent: null })
        .where(eq(SessionTable.id, SessionV2.ID.make("ses_test")))
        .run()
        .pipe(Effect.orDie)
      const agents = yield* AgentV2.Service
      yield* agents.update((editor) => {
        editor.remove(AgentV2.ID.make("test"))
        editor.remove(AgentV2.ID.make("build"))
      })

      const service = yield* PermissionV2.Service
      expect(yield* service.ask(assertion())).toEqual({ id: PermissionV2.ID.create("per_test"), effect: "deny" })
      expect(yield* service.list()).toEqual([])
    }),
  )

  it.effect("evaluates bash with the normal configured-rule semantics", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "*", resource: "*", effect: "allow" }])
      const service = yield* PermissionV2.Service
      const bash = assertion({ action: "bash", resources: ["pwd"] })
      expect(yield* service.ask(bash)).toEqual({ id: PermissionV2.ID.create("per_test"), effect: "allow" })

      yield* setRules([])
      expect(yield* service.ask(bash)).toEqual({ id: PermissionV2.ID.create("per_test"), effect: "ask" })
      expect(yield* service.get(PermissionV2.ID.create("per_test"))).toBeDefined()
    }),
  )

  it.effect("uses saved bash approvals while preserving configured deny precedence", () =>
    Effect.gen(function* () {
      yield* setup()
      const saved = yield* PermissionSaved.Service
      yield* saved.add({ projectID: Project.ID.global, action: "bash", resources: ["pwd"] })

      const service = yield* PermissionV2.Service
      expect(yield* service.ask(assertion({ action: "bash", resources: ["pwd"] }))).toEqual({
        id: PermissionV2.ID.create("per_test"),
        effect: "allow",
      })
      expect(yield* service.list()).toEqual([])

      yield* setRules([{ action: "bash", resource: "*", effect: "deny" }])
      expect(yield* service.ask(assertion({ action: "bash", resources: ["pwd"] }))).toEqual({
        id: PermissionV2.ID.create("per_test"),
        effect: "deny",
      })
    }),
  )

  it.effect("resolves an asked permission once", () =>
    Effect.gen(function* () {
      yield* setup()
      const { service, fiber, request } = yield* waitForRequest()
      expect(yield* service.list()).toEqual([request])
      expect(yield* service.forSession(request.sessionID)).toEqual([request])
      expect(yield* service.forSession(SessionV2.ID.make("ses_other"))).toEqual([])
      expect(yield* service.get(request.id)).toEqual(request)
      yield* service.reply({ requestID: request.id, reply: "once" })
      yield* Fiber.join(fiber)
      expect(yield* service.list()).toEqual([])
      expect(yield* service.get(request.id)).toBeUndefined()
    }),
  )

  it.effect("stores and removes saved resources for a project", () =>
    Effect.gen(function* () {
      yield* setup()
      const service = yield* PermissionV2.Service
      const asked = yield* Deferred.make<PermissionV2.Request>()
      const events = yield* EventV2.Service
      const unsubscribe = yield* events.listen((event) =>
        event.type === PermissionV2.Event.Asked.type
          ? Deferred.succeed(asked, event.data as PermissionV2.Request).pipe(Effect.asVoid)
          : Effect.void,
      )
      yield* Effect.addFinalizer(() => unsubscribe)
      const fiber = yield* service.assert(assertion({ save: ["src/*"] })).pipe(Effect.forkScoped)
      const request = yield* Deferred.await(asked)
      yield* service.reply({ requestID: request.id, reply: "always" })
      yield* Fiber.join(fiber)

      const { db } = yield* Database.Service
      expect(
        yield* db.select().from(PermissionTable).where(eq(PermissionTable.project_id, Project.ID.global)).all(),
      ).toMatchObject([{ action: "read", resource: "src/*" }])
      const saved = yield* PermissionSaved.Service
      const id = (yield* saved.list())[0]!.id
      expect(yield* saved.list()).toEqual([{ id, projectID: Project.ID.global, action: "read", resource: "src/*" }])
      yield* service.assert(assertion({ id: PermissionV2.ID.create("per_next"), resources: ["src/next.ts"] }))
      yield* saved.remove(id)
      expect(yield* saved.list()).toEqual([])
    }),
  )

  it.effect("does not restore ambiguous copied pending permissions across directories", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()).pipe(Effect.orDie),
      )
      const source = AbsolutePath.make(path.join(tmp.path, "source"))
      const target = AbsolutePath.make(path.join(tmp.path, "target"))
      const copiedSessionID = SessionV2.ID.make("ses_permission_copied")
      const requestID = PermissionV2.ID.create("per_copied")

      const sourceSession = SessionV2.Info.make({
        id: copiedSessionID,
        projectID: Project.ID.global,
        title: "Permission source",
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: DateTime.makeUnsafe(1), updated: DateTime.makeUnsafe(1) },
        location: Location.Ref.make({ directory: source }),
        agent: AgentV2.ID.make("test"),
      })
      const targetSession = SessionV2.Info.make({
        ...sourceSession,
        title: "Permission target",
        location: Location.Ref.make({ directory: target }),
      })
      yield* Effect.promise(() => writeSessionStore(sourceSession))
      yield* Effect.promise(() => writeSessionStore(targetSession))

      const request: PermissionV2.Request = {
        id: requestID,
        sessionID: copiedSessionID,
        action: "read",
        resources: ["src/index.ts"],
      }

      yield* Effect.promise(() =>
        appendSessionJsonl(sourceSession, {
          type: PermissionV2.Event.Asked.type,
          ...request,
        }),
      )
      yield* Effect.promise(() =>
        appendSessionJsonl(targetSession, {
          type: PermissionV2.Event.Asked.type,
          ...request,
        }),
      )

      expect(yield* Effect.promise(() => readPermissionStateEntries(tmp.path))).toEqual([])
    }),
  )

  it.effect("reads copied pending permissions from the current location tree", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()).pipe(Effect.orDie),
      )
      const source = AbsolutePath.make(path.join(tmp.path, "source"))
      const target = AbsolutePath.make(path.join(tmp.path, "target"))
      const copiedSessionID = SessionV2.ID.make("ses_permission_restore_target")
      const requestID = PermissionV2.ID.create("per_restore_target")

      const sourceSession = SessionV2.Info.make({
        id: copiedSessionID,
        projectID: Project.ID.global,
        title: "Permission source",
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: DateTime.makeUnsafe(1), updated: DateTime.makeUnsafe(1) },
        location: Location.Ref.make({ directory: source }),
        agent: AgentV2.ID.make("test"),
      })
      const targetSession = SessionV2.Info.make({
        ...sourceSession,
        title: "Permission target",
        location: Location.Ref.make({ directory: target }),
      })
      yield* Effect.promise(() => writeSessionStore(sourceSession))
      yield* Effect.promise(() => writeSessionStore(targetSession))

      const request: PermissionV2.Request = {
        id: requestID,
        sessionID: copiedSessionID,
        action: "read",
        resources: ["src/index.ts"],
      }

      yield* Effect.promise(() =>
        appendSessionJsonl(sourceSession, {
          type: PermissionV2.Event.Asked.type,
          ...request,
        }),
      )
      yield* Effect.promise(() =>
        appendSessionJsonl(targetSession, {
          type: PermissionV2.Event.Asked.type,
          ...request,
        }),
      )

      expect(yield* Effect.promise(() => readPermissionStateEntries(target))).toMatchObject([{ request, directory: target }])
    }),
  )

  it.effect("does not read pending permissions from archived sessions", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()).pipe(Effect.orDie),
      )
      const directory = AbsolutePath.make(tmp.path)
      const archivedSessionID = SessionV2.ID.make("ses_permission_archived_pending")
      const archivedSession = SessionV2.Info.make({
        id: archivedSessionID,
        projectID: Project.ID.global,
        title: "Permission archived",
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: DateTime.makeUnsafe(1), updated: DateTime.makeUnsafe(2), archived: DateTime.makeUnsafe(3) },
        location: Location.Ref.make({ directory }),
        agent: AgentV2.ID.make("test"),
      })
      yield* Effect.promise(() => writeSessionStore(archivedSession))
      yield* Effect.promise(() =>
        appendSessionJsonl(archivedSession, {
          type: PermissionV2.Event.Asked.type,
          id: PermissionV2.ID.create("per_archived_pending"),
          sessionID: archivedSessionID,
          action: "read",
          resources: ["src/index.ts"],
        }),
      )

      expect(yield* Effect.promise(() => readPermissionStateEntries(tmp.path))).toEqual([])
    }),
  )
})
