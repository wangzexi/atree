import { describe, expect, test } from "bun:test"
import { randomUUID } from "crypto"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { MessageTable, PartTable, SessionTable } from "@opencode-ai/core/session/sql"
import { eq } from "drizzle-orm"
import { Deferred, Effect, Exit, Layer, Option } from "effect"
import { Session as SessionNs } from "@/session/session"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { provideInstance, TestInstance, testInstanceStoreLayer, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { NotFoundError, Storage } from "@/storage/storage"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { BackgroundJob } from "@/background/job"
import { EventV2Bridge } from "@/event-v2-bridge"
import { GlobalBus } from "@/bus/global"
import {
  appendSessionJsonl,
  readSessionJsonlMessages,
  readSessionStore,
  writeSessionStore,
} from "@/atree/session-store"
import { writeWorkspaceRoot } from "@/atree/state"
import { InstanceState } from "@/effect/instance-state"

const it = testEffect(
  Layer.mergeAll(
    Database.defaultLayer,
    SessionNs.layer.pipe(
      Layer.provide(Storage.defaultLayer),
      Layer.provide(Database.defaultLayer),
      Layer.provideMerge(EventV2Bridge.defaultLayer),
      Layer.provide(SessionProjector.defaultLayer),
      Layer.provide(RuntimeFlags.layer({ experimentalWorkspaces: false })),
      Layer.provide(BackgroundJob.defaultLayer),
    ),
    CrossSpawnSpawner.defaultLayer,
    testInstanceStoreLayer,
  ),
)

const awaitDeferred = <T>(deferred: Deferred.Deferred<T>, message: string) =>
  Effect.race(
    Deferred.await(deferred),
    Effect.sleep("2 seconds").pipe(Effect.flatMap(() => Effect.fail(new Error(message)))),
  )

const remove = (id: SessionID) => SessionNs.use.remove(id)

test("does not expose a top-level SQLite-only global session list bypass", () => {
  expect((SessionNs as unknown as { listGlobal?: unknown }).listGlobal).toBeUndefined()
})

describe("Session.plan", () => {
  test("stores non-VCS plans inside the session assets directory", () => {
    const sessionID = "ses_plan_assets" as SessionID
    const plan = SessionNs.plan(
      { id: sessionID, slug: "daily-plan", time: { created: 123 } },
      {
        directory: "/workspace/node",
        worktree: "/",
        project: {
          id: "global" as never,
          worktree: "/",
          vcs: undefined,
          sandboxes: [],
          time: { created: 1, updated: 1 },
        },
      },
    )

    expect(plan).toBe(
      path.join(
        "/workspace/node",
        ".agents",
        "atree",
        "sessions",
        sessionID,
        "assets",
        "plans",
        "123-daily-plan.md",
      ),
    )
  })

  test("stores git project plans inside the session assets directory", () => {
    const sessionID = "ses_plan_git" as SessionID
    const plan = SessionNs.plan(
      { id: sessionID, slug: "git-plan", time: { created: 456 } },
      {
        directory: "/workspace/repo/packages/app",
        worktree: "/workspace/repo",
        project: {
          id: "proj_git" as never,
          worktree: "/workspace/repo",
          vcs: "git",
          sandboxes: [],
          time: { created: 1, updated: 1 },
        },
      },
    )

    expect(plan).toBe(
      path.join(
        "/workspace/repo/packages/app",
        ".agents",
        "atree",
        "sessions",
        sessionID,
        "assets",
        "plans",
        "456-git-plan.md",
      ),
    )
  })
})

describe("session.created event", () => {
  it.instance("should emit session.created event when session is created", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const events = yield* EventV2Bridge.Service
      const received = yield* Deferred.make<SessionNs.Info>()

      const unsub = yield* events.listen((event) => {
        if (event.type === SessionNs.Event.Created.type)
          Deferred.doneUnsafe(
            received,
            Effect.succeed((event.data as typeof SessionNs.Event.Created.data.Type).info as SessionNs.Info),
          )
        return Effect.void
      })
      yield* Effect.addFinalizer(() => unsub)

      const info = yield* session.create({})
      const receivedInfo = yield* awaitDeferred(received, "timed out waiting for session.created")

      expect(receivedInfo.id).toBe(info.id)
      expect(receivedInfo.projectID).toBe(info.projectID)
      expect(receivedInfo.directory).toBe(info.directory)
      expect(receivedInfo.path).toBe(info.path)
      expect(receivedInfo.title).toBe(info.title)

      yield* session.remove(info.id)
    }),
  )

  it.instance("session.created event should be emitted before session.updated", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const source = yield* EventV2Bridge.Service
      const events: string[] = []
      const received = yield* Deferred.make<string[]>()
      const push = (event: string) => {
        events.push(event)
        if (events.includes("created") && events.includes("updated")) {
          Deferred.doneUnsafe(received, Effect.succeed(events))
        }
      }

      const unsubscribe = yield* source.listen((event) => {
        if (event.type === SessionNs.Event.Created.type) push("created")
        if (event.type === SessionNs.Event.Updated.type) push("updated")
        return Effect.void
      })
      yield* Effect.addFinalizer(() => unsubscribe)

      const info = yield* session.create({})
      yield* session.setTitle({ sessionID: info.id, title: "updated" })
      const receivedEvents = yield* awaitDeferred(received, "timed out waiting for session created/updated events")

      expect(receivedEvents).toContain("created")
      expect(receivedEvents).toContain("updated")
      expect(receivedEvents.indexOf("created")).toBeLessThan(receivedEvents.indexOf("updated"))

      yield* session.remove(info.id)
    }),
  )

  it.instance("emits legacy global sync payload", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const received = yield* Deferred.make<{ syncEvent: EventV2.SerializedEvent }>()
      const listener = (event: { payload: { type?: string; syncEvent?: EventV2.SerializedEvent } }) => {
        if (event.payload.type === "sync" && event.payload.syncEvent)
          Deferred.doneUnsafe(received, Effect.succeed({ syncEvent: event.payload.syncEvent }))
      }
      GlobalBus.on("event", listener)
      yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", listener)))

      const info = yield* session.create({})
      const event = yield* awaitDeferred(received, "timed out waiting for legacy global sync event")

      expect(event.syncEvent).toMatchObject({
        type: EventV2.versionedType(SessionNs.Event.Created.type, 1),
        seq: 0,
        aggregateID: info.id,
        data: { sessionID: info.id },
      })

      yield* session.remove(info.id)
    }),
  )
})

describe("step-finish token propagation via event", () => {
  it.instance(
    "non-zero tokens propagate through PartUpdated event",
    () =>
      Effect.gen(function* () {
        const session = yield* SessionNs.Service
        const events = yield* EventV2Bridge.Service
        const info = yield* session.create({})

        const messageID = MessageID.ascending()
        yield* session.updateMessage({
          id: messageID,
          sessionID: info.id,
          role: "user",
          time: { created: Date.now() },
          agent: "user",
          model: { providerID: "test", modelID: "test" },
          tools: {},
          mode: "",
        } as unknown as SessionV1.Info)

        // Event subscribers receive readonly Schema.Type payloads; `SessionV1.Part`
        // is the mutable domain type. Cast bridges the two — safe because the
        // test only reads the value afterwards.
        const received = yield* Deferred.make<SessionV1.Part>()
        const unsub = yield* events.listen((event) => {
          if (event.type === MessageV2.Event.PartUpdated.type)
            Deferred.doneUnsafe(
              received,
              Effect.succeed((event.data as typeof MessageV2.Event.PartUpdated.data.Type).part as SessionV1.Part),
            )
          return Effect.void
        })
        yield* Effect.addFinalizer(() => unsub)

        const tokens = {
          total: 1500,
          input: 500,
          output: 800,
          reasoning: 200,
          cache: { read: 100, write: 50 },
        }

        const partInput = {
          id: PartID.ascending(),
          messageID,
          sessionID: info.id,
          type: "step-finish" as const,
          reason: "stop",
          cost: 0.005,
          tokens,
        }

        yield* session.updatePart(partInput)
        const receivedPart = yield* awaitDeferred(received, "timed out waiting for message.part.updated")

        expect(receivedPart.type).toBe("step-finish")
        const finish = receivedPart as SessionV1.StepFinishPart
        expect(finish.tokens.input).toBe(500)
        expect(finish.tokens.output).toBe(800)
        expect(finish.tokens.reasoning).toBe(200)
        expect(finish.tokens.total).toBe(1500)
        expect(finish.tokens.cache.read).toBe(100)
        expect(finish.tokens.cache.write).toBe(50)
        expect(finish.cost).toBe(0.005)
        expect(receivedPart).not.toBe(partInput)

        yield* session.remove(info.id)
      }),
    { timeout: 30000 },
  )
})

describe("Session", () => {
  it.instance("loads session metadata from .agents when the database cache is missing", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const instance = yield* TestInstance
      const ctx = yield* InstanceState.context
      const id = "ses_file_backed" as SessionID

      yield* Effect.promise(() =>
        writeSessionStore({
          id,
          slug: "file-backed",
          version: "test",
          projectID: ctx.project.id,
          directory: instance.directory,
          path: ".",
          title: "File backed",
          metadata: { icon: "🧭" },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 10, updated: 20 },
        } as any),
      )

      const loaded = yield* session.get(id)
      expect(loaded.id).toBe(id)
      expect(loaded.directory).toBe(instance.directory)
      expect(loaded.title).toBe("File backed")
      expect(loaded.metadata).toEqual({ icon: "🧭" })

      yield* Effect.promise(() =>
        writeSessionStore({
          ...loaded,
          title: "File backed updated",
          metadata: { icon: "🦊" },
          time: { ...loaded.time, updated: 25 },
        } as any),
      )
      const reloaded = yield* session.get(id)
      expect(reloaded.title).toBe("File backed updated")
      expect(reloaded.metadata).toEqual({ icon: "🦊" })

      yield* Effect.promise(() =>
        appendSessionJsonl(reloaded, {
          type: "message.updated",
          message: { id: "msg_file", sessionID: id, role: "user", time: { created: 30 } },
        }),
      )
      yield* Effect.promise(() =>
        appendSessionJsonl(reloaded, {
          type: "message.part.updated",
          part: { id: "prt_file", sessionID: id, messageID: "msg_file", type: "text", text: "from file" },
        }),
      )

      const messages = yield* session.messages({ sessionID: id, limit: 10 })
      expect(messages).toHaveLength(1)
      expect(messages[0]?.info).toMatchObject({ id: "msg_file", role: "user" })
      expect(messages[0]?.parts[0]).toMatchObject({ id: "prt_file", type: "text", text: "from file" })

      const part = yield* session.getPart({
        sessionID: id,
        messageID: "msg_file" as MessageID,
        partID: "prt_file" as PartID,
      })
      expect(part).toMatchObject({ id: "prt_file", type: "text", text: "from file" })

      const found = yield* session.findMessage(id, (message) => message.info.id === "msg_file")
      expect(Option.isSome(found) ? found.value.parts[0] : undefined).toMatchObject({
        id: "prt_file",
        type: "text",
        text: "from file",
      })
    }),
  )

  it.effect("reads file-backed messages with an explicit directory and no instance", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const directory = yield* tmpdirScoped()
      const now = Date.now()
      const sessionID = "ses_explicit_messages" as SessionID
      const messageID = "msg_explicit_file" as MessageID
      const partID = "prt_explicit_file" as PartID
      const info = {
        id: sessionID,
        slug: "explicit-messages",
        version: "test",
        projectID: "proj_file",
        directory,
        path: ".",
        title: "Explicit messages",
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: now, updated: now },
      } as any

      yield* Effect.promise(() => writeSessionStore(info))
      yield* Effect.promise(() =>
        appendSessionJsonl(info, {
          type: "message.updated",
          message: { id: messageID, sessionID, role: "user", time: { created: now } },
        }),
      )
      yield* Effect.promise(() =>
        appendSessionJsonl(info, {
          type: "message.part.updated",
          part: { id: partID, sessionID, messageID, type: "text", text: "explicit directory message" },
        }),
      )

      const messages = yield* session.messages({ sessionID, directory, limit: 10 })
      expect(messages).toHaveLength(1)
      expect(messages[0]?.parts[0]).toMatchObject({ id: partID, type: "text", text: "explicit directory message" })

      const part = yield* session.getPart({ sessionID, directory, messageID, partID })
      expect(part).toMatchObject({ id: partID, type: "text", text: "explicit directory message" })

      const found = yield* session.findMessage(sessionID, (message) => message.info.id === messageID, { directory })
      expect(Option.isSome(found) ? found.value.parts[0] : undefined).toMatchObject({
        id: partID,
        type: "text",
        text: "explicit directory message",
      })
    }),
  )

  it.instance("advances directory session metadata when appending message events", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const instance = yield* TestInstance
      const info = yield* session.create({ title: "message-touch-source" })
      const messageID = MessageID.ascending()
      const before = (yield* Effect.promise(() => readSessionStore(instance.directory, info.id)))?.time.updated ?? 0

      yield* Effect.sleep("2 millis")
      yield* session.updateMessage({
        id: messageID,
        sessionID: info.id,
        role: "user",
        time: { created: Date.now() },
        agent: "user",
        model: { providerID: "test", modelID: "test" },
        tools: {},
        mode: "",
      } as unknown as SessionV1.Info)

      const after = (yield* Effect.promise(() => readSessionStore(instance.directory, info.id)))?.time.updated ?? 0
      expect(after).toBeGreaterThan(before)

      yield* session.remove(info.id)
    }),
  )

  it.instance("prefers file metadata from the cached session directory when the current instance differs", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const otherDir = yield* tmpdirScoped({ git: true })
      const info = yield* Effect.acquireRelease(session.create({ title: "stale-cache-title" }), (created) =>
        session.remove(created.id).pipe(Effect.ignore),
      )

      yield* Effect.promise(() =>
        writeSessionStore({
          ...info,
          title: "authoritative-file-title",
          metadata: { icon: "🧭" },
          time: { ...info.time, updated: info.time.updated + 100 },
        } as any),
      )

      const loaded = yield* provideInstance(otherDir)(session.get(info.id))
      expect(loaded.directory).toBe(info.directory)
      expect(loaded.title).toBe("authoritative-file-title")
      expect(loaded.metadata).toEqual({ icon: "🧭" })
    }),
  )

  it.instance("locates a nested file-backed session from the persisted atree root without a database cache", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const instance = yield* TestInstance
      const data = yield* tmpdirScoped()
      const previousData = Global.Path.data
      ;(Global.Path as { data: string }).data = data
      yield* Effect.addFinalizer(() => Effect.sync(() => ((Global.Path as { data: string }).data = previousData)))

      const nodeDirectory = path.join(instance.directory, "nested", "node")
      yield* Effect.promise(() => fs.mkdir(nodeDirectory, { recursive: true }))
      yield* Effect.promise(() => writeWorkspaceRoot(instance.directory))
      const info = yield* session.create({ title: "nested self-contained", directory: nodeDirectory })

      const { db } = yield* Database.Service
      yield* db.delete(SessionTable).where(eq(SessionTable.id, info.id)).run().pipe(Effect.orDie)

      const loaded = yield* session.get(info.id)
      expect(loaded.id).toBe(info.id)
      expect(loaded.directory).toBe(nodeDirectory)
      expect(loaded.title).toBe("nested self-contained")
    }),
  )

  it.instance("localizes copied file-backed child sessions to the target directory", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const source = yield* tmpdirScoped({ git: true })
      const target = yield* tmpdirScoped({ git: true })

      const parent = yield* provideInstance(source)(session.create({ title: "copied-parent" }))
      const child = yield* provideInstance(source)(
        session.create({ parentID: parent.id, title: "copied-child", metadata: { icon: "🧭" } }),
      )
      yield* Effect.promise(() =>
        fs.cp(path.join(source, ".agents"), path.join(target, ".agents"), { recursive: true }),
      )
      const targetCtx = yield* provideInstance(target)(InstanceState.context)

      const children = yield* provideInstance(target)(session.children(parent.id))
      const copied = children.find((item) => item.id === child.id)
      expect(copied?.directory).toBe(target)
      expect(copied?.projectID).toBe(targetCtx.project.id)
      expect(copied?.metadata).toEqual({ icon: "🧭" })
    }),
  )

  it.instance("does not rewrite a valid cached directory when reading a copied session explicitly", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const source = yield* tmpdirScoped({ git: true })
      const target = yield* tmpdirScoped({ git: true })
      const info = yield* provideInstance(source)(session.create({ title: "source cache owner" }))
      yield* Effect.promise(() =>
        fs.cp(path.join(source, ".agents"), path.join(target, ".agents"), { recursive: true }),
      )
      const targetCtx = yield* provideInstance(target)(InstanceState.context)
      yield* Effect.promise(() =>
        writeSessionStore({
          ...info,
          directory: target,
          projectID: targetCtx.project.id,
          title: "target copied session",
        } as any),
      )

      const copied = yield* provideInstance(target)(session.get(info.id, { directory: target }))
      const { db } = yield* Database.Service
      const row = yield* db
        .select({ directory: SessionTable.directory })
        .from(SessionTable)
        .where(eq(SessionTable.id, info.id))
        .get()
        .pipe(Effect.orDie)

      expect(copied.directory).toBe(target)
      expect(copied.title).toBe("target copied session")
      expect(row?.directory).toBe(source)
    }),
  )

  it.effect("reads file-backed child sessions with an explicit directory and no instance", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const directory = yield* tmpdirScoped()
      const now = Date.now()
      const parentID = "ses_explicit_child_parent" as SessionID
      const childID = "ses_explicit_child" as SessionID

      yield* Effect.promise(() =>
        writeSessionStore({
          id: parentID,
          slug: "explicit-child-parent",
          version: "test",
          projectID: "proj_file",
          directory,
          path: ".",
          title: "Explicit child parent",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: now, updated: now },
        } as any),
      )
      yield* Effect.promise(() =>
        writeSessionStore({
          id: childID,
          parentID,
          slug: "explicit-child",
          version: "test",
          projectID: "proj_file",
          directory,
          path: ".",
          title: "Explicit child",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: now, updated: now },
        } as any),
      )

      const children = yield* session.children(parentID, { directory })
      expect(children).toHaveLength(1)
      expect(children[0]).toMatchObject({ id: childID, parentID, directory, title: "Explicit child" })
    }),
  )

  it.instance("prefers in-directory file session children when listing with directory hint", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const { db } = yield* Database.Service
      const parent = yield* session.create({ title: "children-hint-parent" })
      const child = yield* session.create({ parentID: parent.id, title: "children-hint-child" })

      const staleChildID = "ses_children_db_stale" as SessionID
      const now = Date.now()
      yield* db
        .insert(SessionTable)
        .values({
          id: staleChildID,
          project_id: parent.projectID,
          slug: "stale-child",
          directory: parent.directory,
          title: "stale child",
          version: "test",
          cost: 0,
          tokens_input: 0,
          tokens_output: 0,
          tokens_reasoning: 0,
          tokens_cache_read: 0,
          tokens_cache_write: 0,
          time_created: now,
          time_updated: now,
          parent_id: parent.id,
          path: ".",
        } as typeof SessionTable.$inferInsert)
        .run()
        .pipe(Effect.orDie)

      const children = yield* session.children(parent.id, { directory: parent.directory })
      const childIDs = children.map((item) => item.id)
      expect(childIDs).toContain(child.id)
      expect(childIDs).not.toContain(staleChildID)

      yield* db.delete(SessionTable).where(eq(SessionTable.id, staleChildID)).run().pipe(Effect.orDie)
      yield* session.remove(child.id)
      yield* session.remove(parent.id)
    }),
  )

  it.instance("prefers session.jsonl removals over stale cached messages when finding messages", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const info = yield* Effect.acquireRelease(session.create({ title: "jsonl-removal-source" }), (created) =>
        session.remove(created.id).pipe(Effect.ignore),
      )
      const messageID = MessageID.ascending()
      const partID = PartID.ascending()

      yield* session.updateMessage({
        id: messageID,
        sessionID: info.id,
        role: "user",
        time: { created: Date.now() },
        agent: "user",
        model: { providerID: "test", modelID: "test" },
        tools: {},
        mode: "",
      } as unknown as SessionV1.Info)
      yield* session.updatePart({
        id: partID,
        messageID,
        sessionID: info.id,
        type: "text",
        text: "cached only",
      })
      yield* Effect.promise(() => appendSessionJsonl(info, { type: "message.removed", messageID }))

      const messages = yield* session.messages({ sessionID: info.id, limit: 10 })
      expect(messages.some((message) => message.info.id === messageID)).toBe(false)

      const found = yield* session.findMessage(info.id, (message) => message.info.id === messageID)
      expect(Option.isNone(found)).toBe(true)
    }),
  )

  it.effect("prefers file-backed messages over stale SQLite rows when no directory hint is provided", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const data = yield* Effect.acquireRelease(
        Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "atree-message-stale-data-"))),
        (dir) => Effect.promise(() => fs.rm(dir, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "atree-message-stale-root-"))),
        (dir) => Effect.promise(() => fs.rm(dir, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      const previousData = Global.Path.data
      ;(Global.Path as { data: string }).data = data
      yield* Effect.addFinalizer(() => Effect.sync(() => ((Global.Path as { data: string }).data = previousData)))

      const staleDirectory = path.join(root, "old")
      const actualDirectory = path.join(root, "new")
      const suffix = randomUUID().replaceAll("-", "")
      const sessionID = `ses_stale_message_directory_${suffix}` as SessionID
      const staleProjectID = `proj_stale_message_${suffix}`
      const actualProjectID = `proj_actual_message_${suffix}`
      const staleMessageID = `msg_stale_message_cache_${suffix}` as MessageID
      const stalePartID = `prt_stale_message_cache_${suffix}` as PartID
      const actualMessageID = `msg_actual_message_file_${suffix}` as MessageID
      const actualPartID = `prt_actual_message_file_${suffix}` as PartID
      const now = Date.now()
      yield* Effect.promise(() => fs.mkdir(staleDirectory, { recursive: true }))
      yield* Effect.promise(() => fs.mkdir(actualDirectory, { recursive: true }))
      yield* Effect.promise(() => writeWorkspaceRoot(root))
      yield* db
        .insert(ProjectTable)
        .values({
          id: staleProjectID,
          worktree: staleDirectory,
          vcs: null,
          name: null,
          time_created: now,
          time_updated: now,
          sandboxes: [],
        } as unknown as typeof ProjectTable.$inferInsert)
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: staleProjectID,
          slug: "stale-message-directory",
          directory: staleDirectory,
          title: "Stale message directory",
          version: "test",
          cost: 0,
          tokens_input: 0,
          tokens_output: 0,
          tokens_reasoning: 0,
          tokens_cache_read: 0,
          tokens_cache_write: 0,
          time_created: now,
          time_updated: now,
        } as typeof SessionTable.$inferInsert)
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(MessageTable)
        .values({
          id: staleMessageID,
          session_id: sessionID,
          time_created: now + 1,
          time_updated: now + 1,
          data: {
            role: "user",
            time: { created: now + 1 },
          },
        } as typeof MessageTable.$inferInsert)
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(PartTable)
        .values({
          id: stalePartID,
          message_id: staleMessageID,
          session_id: sessionID,
          time_created: now + 1,
          time_updated: now + 1,
          data: { type: "text", text: "stale SQLite message" },
        } as typeof PartTable.$inferInsert)
        .run()
        .pipe(Effect.orDie)
      const actualSession = {
        id: sessionID,
        slug: "actual-message-directory",
        version: "test",
        projectID: actualProjectID,
        directory: actualDirectory,
        path: "new",
        title: "Actual message directory",
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: now, updated: now },
      } as SessionNs.Info
      yield* Effect.promise(() => writeSessionStore(actualSession))
      yield* Effect.promise(() =>
        appendSessionJsonl(actualSession, {
          type: "message.updated",
          message: {
            id: actualMessageID,
            role: "user",
            time: { created: now + 2 },
          },
        }),
      )
      yield* Effect.promise(() =>
        appendSessionJsonl(actualSession, {
          type: "message.part.updated",
          part: {
            id: actualPartID,
            messageID: actualMessageID,
            type: "text",
            text: "actual file-backed message",
          },
        }),
      )

      const page = yield* MessageV2.page({ sessionID, limit: 10 })

      expect(page.items.map((item) => item.info.id)).toEqual([actualMessageID])
      expect(page.items[0]?.parts).toMatchObject([{ text: "actual file-backed message" }])
    }),
  )

  it.instance("prefers session.jsonl part removals over stale cached parts", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const info = yield* Effect.acquireRelease(session.create({ title: "jsonl-part-removal-source" }), (created) =>
        session.remove(created.id).pipe(Effect.ignore),
      )
      const messageID = MessageID.ascending()
      const partID = PartID.ascending()

      yield* session.updateMessage({
        id: messageID,
        sessionID: info.id,
        role: "user",
        time: { created: Date.now() },
        agent: "user",
        model: { providerID: "test", modelID: "test" },
        tools: {},
        mode: "",
      } as unknown as SessionV1.Info)
      yield* session.updatePart({
        id: partID,
        messageID,
        sessionID: info.id,
        type: "text",
        text: "stale part",
      })
      yield* Effect.promise(() => appendSessionJsonl(info, { type: "message.part.removed", messageID, partID }))

      const messages = yield* session.messages({ sessionID: info.id, limit: 10 })
      expect(messages.find((message) => message.info.id === messageID)?.parts).toEqual([])

      const part = yield* session.getPart({ sessionID: info.id, messageID, partID })
      expect(part).toBeUndefined()
    }),
  )

  it.instance("prefers session.jsonl part updates over stale cached parts", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const info = yield* Effect.acquireRelease(session.create({ title: "jsonl-part-update-source" }), (created) =>
        session.remove(created.id).pipe(Effect.ignore),
      )
      const messageID = MessageID.ascending()
      const partID = PartID.ascending()

      yield* session.updateMessage({
        id: messageID,
        sessionID: info.id,
        role: "user",
        time: { created: Date.now() },
        agent: "user",
        model: { providerID: "test", modelID: "test" },
        tools: {},
        mode: "",
      } as unknown as SessionV1.Info)
      yield* session.updatePart({
        id: partID,
        messageID,
        sessionID: info.id,
        type: "text",
        text: "stale cached part",
      })
      yield* Effect.promise(() =>
        appendSessionJsonl(info, {
          type: "message.part.updated",
          part: {
            id: partID,
            messageID,
            sessionID: info.id,
            type: "text",
            text: "authoritative jsonl part",
          },
        }),
      )

      const part = yield* session.getPart({ sessionID: info.id, messageID, partID })
      expect(part).toMatchObject({ id: partID, type: "text", text: "authoritative jsonl part" })

      const found = yield* session.findMessage(info.id, (message) => message.info.id === messageID)
      expect(Option.isSome(found) ? found.value.parts[0] : undefined).toMatchObject({
        id: partID,
        type: "text",
        text: "authoritative jsonl part",
      })
    }),
  )

  it.instance("does not read explicit directory parts from stale SQLite projections", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const instance = yield* TestInstance
      const info = yield* session.create({ title: "explicit-part-cached-only" })
      const messageID = MessageID.ascending()
      const partID = PartID.ascending()

      yield* session.updateMessage({
        id: messageID,
        sessionID: info.id,
        role: "user",
        time: { created: Date.now() },
        agent: "user",
        model: { providerID: "test", modelID: "test" },
        tools: {},
        mode: "",
      } as unknown as SessionV1.Info)
      yield* session.updatePart({
        id: partID,
        messageID,
        sessionID: info.id,
        type: "text",
        text: "stale explicit directory part",
      })
      yield* Effect.promise(() =>
        fs.rm(path.join(instance.directory, ".agents", "atree", "sessions", info.id), {
          recursive: true,
          force: true,
        }),
      )

      const part = yield* session.getPart({ sessionID: info.id, messageID, partID, directory: instance.directory })
      expect(part).toBeUndefined()
    }),
  )

  it.instance("replays moved events without trusting stale absolute directories", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const instance = yield* TestInstance
      const info = yield* Effect.acquireRelease(session.create({ title: "moved-jsonl-source" }), (created) =>
        session.remove(created.id).pipe(Effect.ignore),
      )

      yield* Effect.promise(() =>
        appendSessionJsonl(info, {
          type: "session.next.moved",
          sessionID: info.id,
          location: { directory: "/stale/absolute/path", workspaceID: "wrk_opencode_moved" },
          subdirectory: "nested/path",
          timestamp: 90,
        }),
      )

      const restored = yield* Effect.promise(() => readSessionStore(instance.directory, info.id))

      expect(restored?.directory).toBe(instance.directory)
      expect(restored?.workspaceID).toBe("wrk_opencode_moved" as any)
      expect(restored?.path).toBe("nested/path")
      expect(restored?.time.updated).toBeGreaterThanOrEqual(90)
    }),
  )

  it.instance("replays agent and model switches from session jsonl", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const instance = yield* TestInstance
      const info = yield* Effect.acquireRelease(session.create({ title: "switched-jsonl-source" }), (created) =>
        session.remove(created.id).pipe(Effect.ignore),
      )
      const model = { providerID: "anthropic", modelID: "claude-sonnet-4", variant: "max" }

      yield* Effect.promise(() =>
        appendSessionJsonl(info, {
          type: "session.next.agent.switched",
          sessionID: info.id,
          messageID: MessageID.ascending(),
          agent: "research",
          timestamp: 90,
        }),
      )
      yield* Effect.promise(() =>
        appendSessionJsonl(info, {
          type: "session.next.model.switched",
          sessionID: info.id,
          messageID: MessageID.ascending(),
          model,
          timestamp: 100,
        }),
      )

      const restored = yield* Effect.promise(() => readSessionStore(instance.directory, info.id))

      expect(restored?.agent).toBe("research")
      expect(restored?.model).toMatchObject({
        id: model.modelID,
        providerID: model.providerID,
        variant: model.variant,
      })
      expect(restored?.time.updated).toBeGreaterThanOrEqual(100)
    }),
  )

  it.instance("persists patched session metadata to .agents and refreshes the runtime cache", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const { db } = yield* Database.Service
      const instance = yield* TestInstance
      const info = yield* Effect.acquireRelease(session.create({ title: "patch-source" }), (created) =>
        session.remove(created.id).pipe(Effect.ignore),
      )

      yield* session.setTitle({ sessionID: info.id, title: "Patched title" })
      yield* session.setMetadata({ sessionID: info.id, metadata: { icon: "🧭" } })
      yield* session.setPermission({
        sessionID: info.id,
        permission: [{ permission: "bash", pattern: "*", action: "allow" }],
      })
      yield* session.setArchived({ sessionID: info.id, time: 1234 })
      yield* session.setSummary({
        sessionID: info.id,
        summary: { additions: 1, deletions: 2, files: 3, diffs: [] },
      })
      yield* session.setShare({ sessionID: info.id, share: { url: "https://example.com/share" } })
      yield* session.setWorkspace({ sessionID: info.id, workspaceID: "wrk_patched" as any })
      yield* session.setRevert({
        sessionID: info.id,
        revert: { messageID: "msg_revert", partID: "prt_revert" } as any,
        summary: { additions: 4, deletions: 5, files: 6, diffs: [] },
      })
      yield* session.clearRevert(info.id)

      const stored = yield* Effect.promise(() => readSessionStore(instance.directory, info.id))
      expect(stored?.title).toBe("Patched title")
      expect(stored?.metadata).toEqual({ icon: "🧭" })
      expect(stored?.permission).toEqual([{ permission: "bash", pattern: "*", action: "allow" }])
      expect(stored?.time.archived).toBe(1234)
      expect(stored?.summary).toEqual({ additions: 4, deletions: 5, files: 6, diffs: [] })
      expect(stored?.share).toEqual({ url: "https://example.com/share" })
      expect(stored?.workspaceID).toBe("wrk_patched" as any)
      expect(stored?.revert).toBeUndefined()

      let row = yield* db.select().from(SessionTable).where(eq(SessionTable.id, info.id)).get().pipe(Effect.orDie)
      expect(row?.title).toBe("Patched title")
      expect(row?.metadata).toEqual({ icon: "🧭" })
      expect(row?.permission).toEqual([{ permission: "bash", pattern: "*", action: "allow" }])
      expect(row?.time_archived).toBe(1234)
      expect(row?.summary_additions).toBe(4)
      expect(row?.summary_deletions).toBe(5)
      expect(row?.summary_files).toBe(6)
      expect(row?.share_url).toBe("https://example.com/share")
      expect(row?.workspace_id).toBe("wrk_patched" as any)
      expect(row?.revert).toBeNull()

      yield* session.setArchived({ sessionID: info.id, time: null })

      const unarchived = yield* Effect.promise(() => readSessionStore(instance.directory, info.id))
      expect(unarchived?.time.archived).toBeUndefined()

      row = yield* db.select().from(SessionTable).where(eq(SessionTable.id, info.id)).get().pipe(Effect.orDie)
      expect(row?.time_archived).toBeNull()

      const raw = yield* Effect.promise(() =>
        fs.readFile(path.join(instance.directory, ".agents", "atree", "sessions", info.id, "session.jsonl"), "utf8"),
      )
      const entries = raw
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, any>)
      expect(entries[0]).toMatchObject({ type: "session.created", sessionID: info.id, info: { id: info.id } })
      expect(entries.filter((entry) => entry.type === "session.updated").map((entry) => entry.patch)).toEqual([
        { title: "Patched title" },
        { metadata: { icon: "🧭" } },
        { permission: [{ permission: "bash", pattern: "*", action: "allow" }] },
        { time: { archived: 1234 } },
        { summary: { additions: 1, deletions: 2, files: 3, diffs: [] } },
        { share: { url: "https://example.com/share" } },
        { workspaceID: "wrk_patched" },
        {
          summary: { additions: 4, deletions: 5, files: 6, diffs: [] },
          revert: { messageID: "msg_revert", partID: "prt_revert" },
        },
        { revert: null },
        { time: { archived: null } },
      ])
    }),
  )

  it.effect("patches file-backed session metadata with an explicit directory and no instance", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const { db } = yield* Database.Service
      const directory = yield* tmpdirScoped()
      const now = Date.now()
      const sessionID = "ses_explicit_patch_metadata" as SessionID

      yield* Effect.promise(() =>
        writeSessionStore({
          id: sessionID,
          slug: "explicit-patch-metadata",
          version: "test",
          projectID: "proj_file",
          directory,
          path: ".",
          title: "Before patch",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: now, updated: now },
        } as any),
      )

      yield* session.setTitle({ sessionID, directory, title: "Explicit patched title" })
      yield* session.setMetadata({ sessionID, directory, metadata: { icon: "🧪" } })
      yield* session.setArchived({ sessionID, directory, time: 1234 })

      const stored = yield* Effect.promise(() => readSessionStore(directory, sessionID))
      expect(stored?.title).toBe("Explicit patched title")
      expect(stored?.metadata).toEqual({ icon: "🧪" })
      expect(stored?.time.archived).toBe(1234)

      const row = yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie)
      expect(row?.directory).toBe(directory)
      expect(row?.title).toBe("Explicit patched title")
      expect(row?.metadata).toEqual({ icon: "🧪" })
      expect(row?.time_archived).toBe(1234)
    }),
  )

  it.instance("prefers a newer session jsonl metadata event over stale meta after a crash window", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const instance = yield* TestInstance
      const info = yield* Effect.acquireRelease(session.create({ title: "stale-meta-source" }), (created) =>
        session.remove(created.id).pipe(Effect.ignore),
      )

      yield* Effect.promise(() =>
        appendSessionJsonl(info, {
          type: "session.updated",
          sessionID: info.id,
          patch: { title: "JSONL survived title", metadata: { icon: "🧭" } },
        }),
      )

      const stored = yield* Effect.promise(() => readSessionStore(instance.directory, info.id))
      expect(stored?.title).toBe("JSONL survived title")
      expect(stored?.metadata).toEqual({ icon: "🧭" })

      const loaded = yield* session.get(info.id, { directory: instance.directory })
      expect(loaded.title).toBe("JSONL survived title")
      expect(loaded.metadata).toEqual({ icon: "🧭" })
    }),
  )

  it.instance("writes copied file-backed session metadata to the explicit target directory", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const source = yield* TestInstance
      const target = yield* tmpdirScoped({ git: true })
      const info = yield* session.create({ title: "copied metadata source", metadata: { icon: "🦊" } })

      yield* Effect.promise(() =>
        fs.cp(path.join(source.directory, ".agents"), path.join(target, ".agents"), { recursive: true }),
      )

      yield* session.setTitle({ sessionID: info.id, directory: target, title: "copied metadata target" })
      yield* session.setMetadata({ sessionID: info.id, directory: target, metadata: { icon: "🧭" } })

      const targetStore = yield* Effect.promise(() => readSessionStore(target, info.id))
      const sourceStore = yield* Effect.promise(() => readSessionStore(source.directory, info.id))
      expect(targetStore?.directory).toBe(target)
      expect(targetStore?.title).toBe("copied metadata target")
      expect(targetStore?.metadata).toEqual({ icon: "🧭" })
      expect(sourceStore?.directory).toBe(source.directory)
      expect(sourceStore?.title).toBe("copied metadata source")
      expect(sourceStore?.metadata).toEqual({ icon: "🦊" })
    }),
  )

  it.instance("appends copied file-backed messages to the explicit target directory", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const source = yield* TestInstance
      const target = yield* tmpdirScoped({ git: true })
      const info = yield* session.create({ title: "copied message source" })
      const messageID = MessageID.ascending()
      const partID = PartID.ascending()

      yield* Effect.promise(() =>
        fs.cp(path.join(source.directory, ".agents"), path.join(target, ".agents"), { recursive: true }),
      )

      yield* session.updateMessage(
        {
          id: messageID,
          sessionID: info.id,
          role: "user",
          time: { created: Date.now() },
          agent: "user",
          model: { providerID: "test", modelID: "test" },
          tools: {},
          mode: "",
        } as unknown as SessionV1.Info,
        { directory: target },
      )
      yield* session.updatePart(
        {
          id: partID,
          messageID,
          sessionID: info.id,
          type: "text",
          text: "message written to copied target",
        },
        { directory: target },
      )

      const targetMessages = yield* session.messages({ sessionID: info.id, directory: target, limit: 10 })
      const sourceMessages = yield* session.messages({ sessionID: info.id, directory: source.directory, limit: 10 })
      expect(targetMessages.find((message) => message.info.id === messageID)?.parts[0]).toMatchObject({
        id: partID,
        type: "text",
        text: "message written to copied target",
      })
      expect(sourceMessages.find((message) => message.info.id === messageID)).toBeUndefined()
    }),
  )

  it.instance("prefers archived file metadata over stale cached child sessions", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const parent = yield* Effect.acquireRelease(session.create({ title: "file-child-parent" }), (created) =>
        session.remove(created.id).pipe(Effect.ignore),
      )
      const child = yield* Effect.acquireRelease(
        session.create({ parentID: parent.id, title: "file-child-stale-active" }),
        (created) => session.remove(created.id).pipe(Effect.ignore),
      )

      yield* Effect.promise(() =>
        writeSessionStore({
          ...child,
          time: { ...child.time, archived: Date.now() },
        } as any),
      )

      const children = yield* session.children(parent.id)
      expect(children.map((item) => item.id)).not.toContain(child.id)
    }),
  )

  it.instance("uses file-backed archived metadata to separate active and archived directory lists", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const instance = yield* TestInstance
      const info = yield* Effect.acquireRelease(session.create({ title: "file-list-stale-active" }), (created) =>
        session.remove(created.id).pipe(Effect.ignore),
      )

      yield* Effect.promise(() =>
        writeSessionStore({
          ...info,
          time: { ...info.time, archived: Date.now() },
        } as any),
      )

      const active = yield* session.list({ directory: instance.directory })
      const archived = yield* session.list({ directory: instance.directory, archived: true })

      expect(active.map((item) => item.id)).not.toContain(info.id)
      expect(archived.map((item) => item.id)).toContain(info.id)
    }),
  )

  it.instance("does not list directory sessions that only exist in the stale SQLite cache", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const instance = yield* TestInstance
      const cachedOnly = yield* session.create({ title: "cached-only-session" })

      yield* Effect.promise(() => fs.rm(path.join(instance.directory, ".agents", "atree", "sessions", cachedOnly.id), {
        recursive: true,
        force: true,
      }))

      const active = yield* session.list({ directory: instance.directory })
      const archived = yield* session.list({ directory: instance.directory, archived: true })

      expect(active.map((item) => item.id)).not.toContain(cachedOnly.id)
      expect(archived.map((item) => item.id)).not.toContain(cachedOnly.id)
    }),
  )

  it.instance("does not load an explicit directory session that only exists in the stale SQLite cache", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const instance = yield* TestInstance
      const cachedOnly = yield* session.create({ title: "cached-only-explicit-session" })

      yield* Effect.promise(() =>
        fs.rm(path.join(instance.directory, ".agents", "atree", "sessions", cachedOnly.id), {
          recursive: true,
          force: true,
        }),
      )

      const error = yield* Effect.flip(session.get(cachedOnly.id, { directory: instance.directory }))
      expect(error).toBeInstanceOf(NotFoundError)
      expect(error.message).toBe(`Session not found: ${cachedOnly.id}`)
    }),
  )

  it.instance("does not list global directory sessions that only exist in the stale SQLite cache", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const instance = yield* TestInstance
      const cachedOnly = yield* session.create({ title: "global-cached-only-session" })

      yield* Effect.promise(() => fs.rm(path.join(instance.directory, ".agents", "atree", "sessions", cachedOnly.id), {
        recursive: true,
        force: true,
      }))

      const global = yield* session.listGlobal({ directory: instance.directory })

      expect(global.map((item) => item.id)).not.toContain(cachedOnly.id)
    }),
  )

  it.instance("does not list unscoped persisted-root sessions that only exist in the stale SQLite cache", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const instance = yield* TestInstance
      const data = yield* Effect.acquireRelease(
        Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "atree-session-global-data-"))),
        (dir) => Effect.promise(() => fs.rm(dir, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      const previousData = Global.Path.data
      ;(Global.Path as { data: string }).data = data
      yield* Effect.addFinalizer(() => Effect.sync(() => ((Global.Path as { data: string }).data = previousData)))

      const cachedOnly = yield* session.create({ title: "global-root-cached-only-session" })
      yield* Effect.promise(() => writeWorkspaceRoot(instance.directory))
      yield* Effect.promise(() =>
        fs.rm(path.join(instance.directory, ".agents", "atree", "sessions", cachedOnly.id), {
          recursive: true,
          force: true,
        }),
      )

      const global = yield* session.listGlobal()

      expect(global.map((item) => item.id)).not.toContain(cachedOnly.id)
    }),
  )

  it.instance("does not load an unscoped persisted-root session that only exists in the stale SQLite cache", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const instance = yield* TestInstance
      const data = yield* Effect.acquireRelease(
        Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "atree-session-get-data-"))),
        (dir) => Effect.promise(() => fs.rm(dir, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      const previousData = Global.Path.data
      ;(Global.Path as { data: string }).data = data
      yield* Effect.addFinalizer(() => Effect.sync(() => ((Global.Path as { data: string }).data = previousData)))

      const cachedOnly = yield* session.create({ title: "root-get-cached-only-session" })
      yield* Effect.promise(() => writeWorkspaceRoot(instance.directory))
      yield* Effect.promise(() =>
        fs.rm(path.join(instance.directory, ".agents", "atree", "sessions", cachedOnly.id), {
          recursive: true,
          force: true,
        }),
      )

      const error = yield* Effect.flip(session.get(cachedOnly.id))
      expect(error).toBeInstanceOf(NotFoundError)
      expect(error.message).toBe(`Session not found: ${cachedOnly.id}`)
    }),
  )

  it.instance("materializes data-url file parts into the session assets directory", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const instance = yield* TestInstance
      const info = yield* session.create({ title: "asset-session" })
      const messageID = MessageID.ascending()

      yield* session.updateMessage({
        id: messageID,
        sessionID: info.id,
        role: "user",
        time: { created: Date.now() },
        agent: "user",
        model: { providerID: "test", modelID: "test" },
        tools: {},
        mode: "",
      } as unknown as SessionV1.Info)
      yield* session.updatePart({
        id: PartID.ascending(),
        messageID,
        sessionID: info.id,
        type: "file",
        mime: "image/png",
        filename: "asset.png",
        url: "data:image/png;base64,YXNzZXQ=",
      })

      const assetRoot = path.join(instance.directory, ".agents", "atree", "sessions", info.id, "assets")
      const assets = yield* Effect.promise(() => fs.readdir(assetRoot))
      expect(assets).toHaveLength(1)
      const asset = yield* Effect.promise(() => fs.readFile(path.join(assetRoot, assets[0]!)))
      expect(asset.toString("utf8")).toBe("asset")

      yield* session.remove(info.id)
    }),
  )

  it.instance("deletes the directory session store so removed sessions do not revive from .agents", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const instance = yield* TestInstance
      const info = yield* session.create({ title: "delete-source", metadata: { icon: "🧹" } })
      const root = path.join(instance.directory, ".agents", "atree", "sessions", info.id)

      expect((yield* Effect.promise(() => fs.stat(path.join(root, "meta.yaml")))).isFile()).toBe(true)
      yield* session.remove(info.id)

      expect(yield* Effect.promise(() => readSessionStore(instance.directory, info.id))).toBeUndefined()
      expect(
        yield* Effect.promise(() =>
          fs.stat(root).then(
            () => true,
            () => false,
          ),
        ),
      ).toBe(false)
      expect(
        (yield* session.list({ directory: instance.directory, archived: true })).map((item) => item.id),
      ).not.toContain(info.id)
    }),
  )

  it.effect("removes a file-backed session with an explicit directory and no instance", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const directory = yield* tmpdirScoped()
      const now = Date.now()
      const sessionID = "ses_explicit_remove" as SessionID

      yield* Effect.promise(() =>
        writeSessionStore({
          id: sessionID,
          slug: "explicit-remove",
          version: "test",
          projectID: "proj_file",
          directory,
          path: ".",
          title: "Explicit remove",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: now, updated: now },
        } as any),
      )

      const root = path.join(directory, ".agents", "atree", "sessions", sessionID)
      expect((yield* Effect.promise(() => fs.stat(path.join(root, "meta.yaml")))).isFile()).toBe(true)

      yield* session.remove(sessionID, { directory })

      expect(yield* Effect.promise(() => readSessionStore(directory, sessionID))).toBeUndefined()
      expect(
        yield* Effect.promise(() =>
          fs.stat(root).then(
            () => true,
            () => false,
          ),
        ),
      ).toBe(false)
    }),
  )

  it.instance("forks a file-backed session history into a new directory-backed session", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const instance = yield* TestInstance
      const nodeDirectory = path.join(instance.directory, "node-fork")
      yield* Effect.promise(() => fs.mkdir(nodeDirectory, { recursive: true }))
      const source = yield* session.create({
        title: "File fork source",
        directory: nodeDirectory,
        metadata: { icon: "🧭" },
      })
      const sourceID = source.id
      const messageID = MessageID.ascending()
      const partID = PartID.ascending()
      const filePartID = PartID.ascending()
      yield* Effect.promise(() =>
        appendSessionJsonl(source, {
          type: "message.updated",
          message: {
            id: messageID,
            sessionID: sourceID,
            role: "user",
            agent: "build",
            model: { providerID: "test", modelID: "test" },
            tools: {},
            mode: "",
            time: { created: 30 },
          },
        }),
      )
      yield* Effect.promise(() =>
        appendSessionJsonl(source, {
          type: "message.part.updated",
          part: {
            id: partID,
            sessionID: sourceID,
            messageID,
            type: "text",
            text: "copy me from jsonl",
          },
        }),
      )
      yield* Effect.promise(() =>
        appendSessionJsonl(source, {
          type: "message.part.updated",
          part: {
            id: filePartID,
            sessionID: sourceID,
            messageID,
            type: "file",
            mime: "image/png",
            filename: "fork-source.png",
            url: "data:image/png;base64,Zm9yay1hc3NldA==",
          },
        }),
      )

      const fork = yield* Effect.acquireRelease(session.fork({ sessionID: sourceID }), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )
      const forkMessages = yield* Effect.promise(() => readSessionJsonlMessages(fork as any))
      const forkText = JSON.stringify(forkMessages)
      const forkAssetsRoot = path.join(nodeDirectory, ".agents", "atree", "sessions", fork.id, "assets")
      const forkAssets = yield* Effect.promise(() => fs.readdir(forkAssetsRoot))
      const forkAsset = yield* Effect.promise(() => fs.readFile(path.join(forkAssetsRoot, forkAssets[0]!)))

      expect(fork.directory).toBe(nodeDirectory)
      expect(fork.metadata).toEqual({ icon: "🧭" })
      expect(forkText).toContain("copy me from jsonl")
      expect(forkText).toContain("data:image/png;base64,Zm9yay1hc3NldA==")
      expect(forkText).toContain(String(fork.id))
      expect(forkText).not.toContain(String(sourceID))
      expect(forkAssets).toHaveLength(1)
      expect(forkAsset.toString("utf8")).toBe("fork-asset")
    }),
  )

  it.instance("forks copied file-backed session history from the explicit target directory", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const source = yield* TestInstance
      const target = yield* tmpdirScoped({ git: true })
      const original = yield* session.create({ title: "copied fork source", metadata: { icon: "🦊" } })
      const messageID = MessageID.ascending()
      const partID = PartID.ascending()

      yield* Effect.promise(() =>
        appendSessionJsonl(original, {
          type: "message.updated",
          message: {
            id: messageID,
            sessionID: original.id,
            role: "user",
            agent: "build",
            model: { providerID: "test", modelID: "test" },
            tools: {},
            mode: "",
            time: { created: 30 },
          },
        }),
      )
      yield* Effect.promise(() =>
        appendSessionJsonl(original, {
          type: "message.part.updated",
          part: {
            id: partID,
            sessionID: original.id,
            messageID,
            type: "text",
            text: "source fork text",
          },
        }),
      )
      yield* Effect.promise(() =>
        fs.cp(path.join(source.directory, ".agents"), path.join(target, ".agents"), { recursive: true }),
      )
      yield* session.setTitle({ sessionID: original.id, directory: target, title: "copied fork target" })
      yield* session.setMetadata({ sessionID: original.id, directory: target, metadata: { icon: "🧭" } })
      yield* Effect.promise(() =>
        appendSessionJsonl({ ...original, directory: target }, {
          type: "message.part.updated",
          part: {
            id: partID,
            sessionID: original.id,
            messageID,
            type: "text",
            text: "target fork text",
          },
        }),
      )

      const fork = yield* Effect.acquireRelease(session.fork({ sessionID: original.id, directory: target }), (info) =>
        session.remove(info.id, { directory: info.directory }).pipe(Effect.ignore),
      )
      const forkMessages = yield* Effect.promise(() => readSessionJsonlMessages(fork as any))
      const forkText = JSON.stringify(forkMessages)

      expect(fork.directory).toBe(target)
      expect(fork.metadata).toEqual({ icon: "🧭" })
      expect(forkText).toContain("target fork text")
      expect(forkText).not.toContain("source fork text")
    }),
  )

  it.live("remove works without an instance", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const dir = yield* tmpdirScoped({ git: true })
      const info = yield* provideInstance(dir)(session.create({ title: "remove-without-instance" }))

      const removeExit = yield* remove(info.id).pipe(Effect.exit)
      expect(Exit.isSuccess(removeExit)).toBe(true)

      const getExit = yield* session.get(info.id).pipe(Effect.exit)
      expect(Exit.isFailure(getExit)).toBe(true)
    }),
  )

  it.instance("persists metadata and copies it on fork by default", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const meta = { source: "sdk", trace: { id: "abc" } }
      const created = yield* Effect.acquireRelease(session.create({ title: "with-meta", metadata: meta }), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )
      const saved = yield* session.get(created.id)
      const fork = yield* Effect.acquireRelease(session.fork({ sessionID: created.id }), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )

      expect(saved.metadata).toEqual(meta)
      expect(fork.metadata).toEqual(meta)
      expect(fork.metadata).not.toBe(meta)
    }),
  )

  it.instance("omits metadata when not provided", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const created = yield* Effect.acquireRelease(session.create({ title: "empty-meta" }), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )
      const saved = yield* session.get(created.id)

      expect(created.metadata).toBeUndefined()
      expect(saved.metadata).toBeUndefined()
    }),
  )
})
