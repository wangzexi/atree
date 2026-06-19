import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { eq } from "drizzle-orm"
import { Deferred, Effect, Exit, Layer, Option } from "effect"
import { Session as SessionNs } from "@/session/session"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { provideInstance, TestInstance, testInstanceStoreLayer, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { Storage } from "@/storage/storage"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { BackgroundJob } from "@/background/job"
import { EventV2Bridge } from "@/event-v2-bridge"
import { GlobalBus } from "@/bus/global"
import { appendSessionJsonl, readSessionJsonlMessages, readSessionStore, writeSessionStore } from "@/atree/session-store"
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

  it.instance("localizes copied file-backed child sessions to the target directory", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const source = yield* tmpdirScoped({ git: true })
      const target = yield* tmpdirScoped({ git: true })

      const parent = yield* provideInstance(source)(session.create({ title: "copied-parent" }))
      const child = yield* provideInstance(source)(
        session.create({ parentID: parent.id, title: "copied-child", metadata: { icon: "🧭" } }),
      )
      yield* Effect.promise(() => fs.cp(path.join(source, ".agents"), path.join(target, ".agents"), { recursive: true }))
      const targetCtx = yield* provideInstance(target)(InstanceState.context)

      const children = yield* provideInstance(target)(session.children(parent.id))
      const copied = children.find((item) => item.id === child.id)
      expect(copied?.directory).toBe(target)
      expect(copied?.projectID).toBe(targetCtx.project.id)
      expect(copied?.metadata).toEqual({ icon: "🧭" })
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
      yield* session.setArchived({ sessionID: info.id, time: 1234 })

      const stored = yield* Effect.promise(() => readSessionStore(instance.directory, info.id))
      expect(stored?.title).toBe("Patched title")
      expect(stored?.metadata).toEqual({ icon: "🧭" })
      expect(stored?.time.archived).toBe(1234)

      let row = yield* db.select().from(SessionTable).where(eq(SessionTable.id, info.id)).get().pipe(Effect.orDie)
      expect(row?.title).toBe("Patched title")
      expect(row?.metadata).toEqual({ icon: "🧭" })
      expect(row?.time_archived).toBe(1234)

      yield* session.setArchived({ sessionID: info.id, time: null })

      const unarchived = yield* Effect.promise(() => readSessionStore(instance.directory, info.id))
      expect(unarchived?.time.archived).toBeUndefined()

      row = yield* db.select().from(SessionTable).where(eq(SessionTable.id, info.id)).get().pipe(Effect.orDie)
      expect(row?.time_archived).toBeNull()
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
      expect(yield* Effect.promise(() => fs.stat(root).then(() => true, () => false))).toBe(false)
      expect((yield* session.list({ directory: instance.directory, archived: true })).map((item) => item.id)).not.toContain(
        info.id,
      )
    }),
  )

  it.instance("forks a file-backed session history into a new directory-backed session", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const instance = yield* TestInstance
      const ctx = yield* InstanceState.context
      const sourceID = "ses_file_fork_source" as SessionID
      const messageID = MessageID.ascending()
      const partID = PartID.ascending()
      const source = {
        id: sourceID,
        slug: "file-fork-source",
        version: "test",
        projectID: ctx.project.id,
        directory: instance.directory,
        path: ".",
        title: "File fork source",
        metadata: { icon: "🧭" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: 10, updated: 20 },
      } as any

      yield* Effect.promise(() => writeSessionStore(source))
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

      const fork = yield* Effect.acquireRelease(session.fork({ sessionID: sourceID }), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )
      const forkMessages = yield* Effect.promise(() => readSessionJsonlMessages(fork as any))
      const forkText = JSON.stringify(forkMessages)

      expect(fork.directory).toBe(instance.directory)
      expect(fork.metadata).toEqual({ icon: "🧭" })
      expect(forkText).toContain("copy me from jsonl")
      expect(forkText).toContain(String(fork.id))
      expect(forkText).not.toContain(String(sourceID))
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
