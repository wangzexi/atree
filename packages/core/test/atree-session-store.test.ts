import { describe, expect } from "bun:test"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { Global } from "@opencode-ai/core/global"
import { Location } from "@opencode-ai/core/location"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { FileAttachment, Prompt } from "@opencode-ai/core/session/prompt"
import { SessionMessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SessionStore } from "@opencode-ai/core/session/store"
import { readSessionStore } from "@opencode-ai/core/atree/session-store"
import { eq } from "drizzle-orm"
import { DateTime, Effect, Layer } from "effect"
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "fs/promises"
import os from "os"
import path from "path"
import { testEffect } from "./lib/effect"

const database = Database.layerFromPath(":memory:")
const events = EventV2.layer.pipe(Layer.provide(database))
const projector = SessionProjector.layer.pipe(Layer.provide(events), Layer.provide(database))
const sessionsLayer = SessionV2.layer.pipe(
  Layer.provide(events),
  Layer.provide(database),
  Layer.provide(Project.defaultLayer),
  Layer.provide(SessionStore.layer.pipe(Layer.provide(database))),
  Layer.provide(SessionExecution.noopLayer),
  Layer.provide(projector),
)
const it = testEffect(Layer.mergeAll(database, events, projector, sessionsLayer))
const storeIt = testEffect(Layer.mergeAll(database, SessionStore.layer.pipe(Layer.provide(database))))

async function writeAtreeSession(input: {
  root: string
  directory: string
  sessionID: string
  title: string
  createdAt: number
  updatedAt: number
  archivedAt?: number | null
}) {
  await mkdir(path.join(Global.Path.data, "atree"), { recursive: true })
  await writeFile(
    path.join(Global.Path.data, "atree", "state.json"),
    JSON.stringify({ version: 1, rootDirectory: input.root, updatedAt: 1 }),
  )
  const sessionRoot = path.join(input.directory, ".agents", "atree", "sessions", input.sessionID)
  await mkdir(sessionRoot, { recursive: true })
  await writeFile(
    path.join(sessionRoot, "meta.yaml"),
    [
      "version: 1",
      `id: ${JSON.stringify(input.sessionID)}`,
      `slug: ${JSON.stringify(input.sessionID)}`,
      `sessionVersion: "atree-test"`,
      `projectID: "global"`,
      `workspaceID: null`,
      `path: "."`,
      `parentID: null`,
      `title: ${JSON.stringify(input.title)}`,
      `agent: null`,
      `model: null`,
      `createdAt: ${input.createdAt}`,
      `updatedAt: ${input.updatedAt}`,
      `archivedAt: ${input.archivedAt ?? null}`,
      `cost: 0`,
      `tokens: {"input":0,"output":0,"reasoning":0,"cache":{"read":0,"write":0}}`,
      `metadata: {}`,
      "",
    ].join("\n"),
  )
}

async function appendSessionJsonl(directory: string, sessionID: string, entries: Record<string, unknown>[]) {
  await writeFile(
    path.join(directory, ".agents", "atree", "sessions", sessionID, "session.jsonl"),
    entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
  )
}

describe("atree file-backed SessionV2 discovery", () => {
  it.effect("creates a directory-backed session skeleton through v2 create", () =>
    Effect.gen(function* () {
      const node = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "atree-core-create-")))
      const sessions = yield* SessionV2.Service
      const session = yield* sessions.create({
        id: SessionV2.ID.make("ses_core_create_store"),
        location: Location.Ref.make({ directory: AbsolutePath.make(node) }),
      })
      const sessionRoot = path.join(node, ".agents", "atree", "sessions", session.id)

      const directoryMeta = yield* Effect.promise(() => readFile(path.join(node, ".agents", "atree", "meta.yaml"), "utf8"))
      const meta = yield* Effect.promise(() => readFile(path.join(sessionRoot, "meta.yaml"), "utf8"))
      const jsonl = yield* Effect.promise(() => readFile(path.join(sessionRoot, "session.jsonl"), "utf8"))
      const assets = yield* Effect.promise(() => readdir(path.join(sessionRoot, "assets")))

      expect(directoryMeta).toContain('source: "atree"')
      expect(meta).toContain('id: "ses_core_create_store"')
      expect(meta).toContain("createdAt:")
      const entries = jsonl
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>)
      expect(entries).toHaveLength(1)
      expect(entries[0]).toMatchObject({
        type: "session.created",
        sessionID: "ses_core_create_store",
        info: { id: "ses_core_create_store" },
      })
      expect(assets).toEqual([])

      const { db } = yield* Database.Service
      yield* db.delete(SessionTable).where(eq(SessionTable.id, session.id)).run().pipe(Effect.orDie)
      const listed = yield* sessions.list({ directory: AbsolutePath.make(node), limit: 10 })
      expect(listed.map((item) => item.id)).toContain(session.id)
    }),
  )

  it.effect("loads a file-backed session from the persisted atree root when SQLite has no row", () =>
    Effect.gen(function* () {
      const data = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "atree-core-data-")))
      const root = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "atree-core-root-")))
      const node = path.join(root, "inbox")
      const previousData = Global.Path.data
      ;(Global.Path as { data: string }).data = data
      yield* Effect.addFinalizer(() => Effect.sync(() => ((Global.Path as { data: string }).data = previousData)))

      const sessionID = SessionV2.ID.make("ses_core_file_backed")
      yield* Effect.promise(() =>
        writeAtreeSession({
          root,
          directory: node,
          sessionID,
          title: "Core file backed",
          createdAt: 10,
          updatedAt: 20,
        }),
      )

      const sessions = yield* SessionV2.Service
      const loaded = yield* sessions.get(sessionID)

      expect(loaded.id).toBe(sessionID)
      expect(loaded.title).toBe("Core file backed")
      expect(loaded.location.directory).toBe(AbsolutePath.make(yield* Effect.promise(() => realpath(node))))
      expect(DateTime.toEpochMillis(loaded.time.created)).toBe(10)
    }),
  )

  it.effect("merges file-backed sessions into directory-scoped v2 lists", () =>
    Effect.gen(function* () {
      const data = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "atree-core-data-")))
      const root = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "atree-core-root-")))
      const node = path.join(root, "inbox")
      const previousData = Global.Path.data
      ;(Global.Path as { data: string }).data = data
      yield* Effect.addFinalizer(() => Effect.sync(() => ((Global.Path as { data: string }).data = previousData)))

      yield* Effect.promise(() =>
        writeAtreeSession({
          root,
          directory: node,
          sessionID: "ses_core_list_a",
          title: "Core list A",
          createdAt: 10,
          updatedAt: 20,
        }),
      )
      yield* Effect.promise(() =>
        writeAtreeSession({
          root,
          directory: node,
          sessionID: "ses_core_list_b",
          title: "Core list B",
          createdAt: 30,
          updatedAt: 40,
        }),
      )

      const sessions = yield* SessionV2.Service
      const listed = yield* sessions.list({ directory: AbsolutePath.make(node), limit: 10 })

      expect(listed.map((session) => session.id)).toEqual([
        SessionV2.ID.make("ses_core_list_b"),
        SessionV2.ID.make("ses_core_list_a"),
      ])
      expect(listed.map((session) => session.title)).toEqual(["Core list B", "Core list A"])
    }),
  )

  it.effect("excludes archived file-backed sessions from directory lists by default", () =>
    Effect.gen(function* () {
      const data = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "atree-core-archive-data-")))
      const root = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "atree-core-archive-root-")))
      const node = path.join(root, "archive")
      const previousData = Global.Path.data
      ;(Global.Path as { data: string }).data = data
      yield* Effect.addFinalizer(() => Effect.sync(() => ((Global.Path as { data: string }).data = previousData)))

      yield* Effect.promise(() =>
        writeAtreeSession({
          root,
          directory: node,
          sessionID: "ses_core_list_active",
          title: "Core list active",
          createdAt: 10,
          updatedAt: 20,
        }),
      )
      yield* Effect.promise(() =>
        writeAtreeSession({
          root,
          directory: node,
          sessionID: "ses_core_list_archived",
          title: "Core list archived",
          createdAt: 30,
          updatedAt: 40,
          archivedAt: 50,
        }),
      )

      const sessions = yield* SessionV2.Service
      const active = yield* sessions.list({ directory: AbsolutePath.make(node), limit: 10 })
      const withArchived = yield* sessions.list({ directory: AbsolutePath.make(node), limit: 10, archived: true })

      expect(active.map((session) => session.id)).toEqual([SessionV2.ID.make("ses_core_list_active")])
      expect(withArchived.map((session) => session.id)).toEqual([
        SessionV2.ID.make("ses_core_list_archived"),
        SessionV2.ID.make("ses_core_list_active"),
      ])
    }),
  )

  it.effect("ignores stale SQLite rows when a directory-backed session store is removed", () =>
    Effect.gen(function* () {
      const node = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "atree-core-stale-")))
      const sessions = yield* SessionV2.Service
      const created = yield* sessions.create({
        id: SessionV2.ID.make("ses_core_stale_cache"),
        location: Location.Ref.make({ directory: AbsolutePath.make(node) }),
      })

      const sessionRoot = path.join(node, ".agents", "atree", "sessions", created.id)
      yield* Effect.promise(() => rm(sessionRoot, { recursive: true, force: true }))

      const listed = yield* sessions.list({ directory: AbsolutePath.make(node), limit: 10 })
      expect(listed.map((session) => session.id)).not.toContain(created.id)
    }),
  )

  it.effect("replays session metadata updates from session jsonl when core reads file-backed sessions", () =>
    Effect.gen(function* () {
      const data = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "atree-core-jsonl-meta-data-")))
      const root = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "atree-core-jsonl-meta-root-")))
      const node = path.join(root, "notes")
      const previousData = Global.Path.data
      ;(Global.Path as { data: string }).data = data
      yield* Effect.addFinalizer(() => Effect.sync(() => ((Global.Path as { data: string }).data = previousData)))
      const sessionID = SessionV2.ID.make("ses_core_jsonl_meta")
      yield* Effect.promise(() =>
        writeAtreeSession({
          root,
          directory: node,
          sessionID,
          title: "Stale core title",
          createdAt: 10,
          updatedAt: 20,
          archivedAt: 30,
        }),
      )
      yield* Effect.promise(() =>
        appendSessionJsonl(node, sessionID, [
          {
            version: 1,
            at: 100,
            type: "session.updated",
            sessionID,
            patch: { title: "JSONL core title", workspaceID: "wrk_core_jsonl" },
          },
          {
            version: 1,
            at: 110,
            type: "session.updated",
            sessionID,
            patch: { time: { archived: null } },
          },
        ]),
      )

      const sessions = yield* SessionV2.Service
      const loaded = yield* sessions.get(sessionID, { directory: AbsolutePath.make(node) })

      expect(loaded.title).toBe("JSONL core title")
      expect(loaded.location.workspaceID).toBe("wrk_core_jsonl" as any)
      expect(loaded.time.archived).toBeUndefined()
      expect(DateTime.toEpochMillis(loaded.time.updated)).toBe(110)
    }),
  )

  it.effect("replays core session info fields from session jsonl when meta is stale", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "atree-core-jsonl-info-root-")))
      const node = path.join(root, "info")
      const sessionID = SessionV2.ID.make("ses_core_jsonl_info")
      yield* Effect.promise(() =>
        writeAtreeSession({
          root,
          directory: node,
          sessionID,
          title: "Stale info",
          createdAt: 10,
          updatedAt: 20,
        }),
      )
      yield* Effect.promise(() =>
        appendSessionJsonl(node, sessionID, [
          {
            version: 1,
            at: 120,
            type: "session.updated",
            sessionID,
            patch: {
              title: "JSONL info",
              agent: "build",
              model: { providerID: "test-provider", modelID: "test-model", variant: "fast" },
              cost: 1.25,
              tokens: { input: 10, output: 20, reasoning: 3, cache: { read: 4, write: 5 } },
              time: { created: 5, updated: 110 },
            },
          },
          {
            version: 1,
            at: 130,
            type: "session.updated",
            sessionID,
            data: {
              info: {
                title: "Nested JSONL info",
                agent: "review",
                model: { providerID: "nested-provider", id: "nested-model", variant: "accurate" },
                cost: 2.5,
                tokens: { input: 11, output: 22, reasoning: 4, cache: { read: 6, write: 7 } },
                time: { updated: 125 },
              },
            },
          },
        ]),
      )

      const restored = yield* Effect.promise(() => readSessionStore(node, sessionID))

      expect(restored?.title).toBe("Nested JSONL info")
      expect(restored?.agent).toBe("review" as any)
      expect(restored?.model).toMatchObject({ providerID: "nested-provider", id: "nested-model", variant: "accurate" } as any)
      expect(restored?.cost).toBe(2.5)
      expect(restored?.tokens).toEqual({ input: 11, output: 22, reasoning: 4, cache: { read: 6, write: 7 } })
      expect(DateTime.toEpochMillis(restored!.time.created)).toBe(5)
      expect(DateTime.toEpochMillis(restored!.time.updated)).toBe(130)
    }),
  )

  it.effect("rebuilds file metadata from session.created when meta.yaml is missing", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "atree-core-created-root-")))
      const node = path.join(root, "created")
      const sessionID = SessionV2.ID.make("ses_core_created_jsonl")
      yield* Effect.promise(() => mkdir(path.join(node, ".agents", "atree", "sessions", sessionID), { recursive: true }))
      yield* Effect.promise(() =>
        appendSessionJsonl(node, sessionID, [
          {
            version: 1,
            at: 100,
            type: "session.created",
            sessionID,
            info: {
              id: sessionID,
              slug: "core-created-jsonl",
              version: "test",
              projectID: "global",
              location: { directory: "/stale/source", workspaceID: "wrk_core_created" },
              subpath: ".",
              title: "Created from core JSONL",
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              time: { created: 10, updated: 20, archived: 30 },
            },
          },
          {
            version: 1,
            at: 110,
            type: "session.updated",
            sessionID,
            patch: { title: "Updated from core JSONL", time: { archived: null } },
          },
        ]),
      )

      const restored = yield* Effect.promise(() => readSessionStore(node, sessionID))
      expect(restored?.id).toBe(sessionID)
      expect(restored?.location.directory).toBe(node as any)
      expect(restored?.location.workspaceID).toBe("wrk_core_created" as any)
      expect(restored?.title).toBe("Updated from core JSONL")
      expect(restored?.time.archived).toBeUndefined()
      expect(DateTime.toEpochMillis(restored!.time.created)).toBe(10)
      expect(DateTime.toEpochMillis(restored!.time.updated)).toBe(110)
    }),
  )

  it.effect("rebuilds file metadata from nested session.created event data", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "atree-core-created-nested-root-")))
      const node = path.join(root, "created-nested")
      const sessionID = SessionV2.ID.make("ses_core_created_jsonl_nested")
      yield* Effect.promise(() => mkdir(path.join(node, ".agents", "atree", "sessions", sessionID), { recursive: true }))
      yield* Effect.promise(() =>
        appendSessionJsonl(node, sessionID, [
          {
            version: 1,
            at: 100,
            type: "session.created",
            sessionID,
            data: {
              info: {
                id: sessionID,
                slug: "core-created-jsonl-nested",
                version: "test",
                projectID: "global",
                location: { directory: "/stale/source", workspaceID: "wrk_core_created_nested" },
                subpath: ".",
                title: "Nested created from core JSONL",
                cost: 0,
                tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                time: { created: 10, updated: 20, archived: 30 },
              },
            },
          },
          {
            version: 1,
            at: 110,
            type: "session.updated",
            sessionID,
            data: { patch: { title: "Nested updated from core JSONL", time: { archived: null } } },
          },
        ]),
      )

      const restored = yield* Effect.promise(() => readSessionStore(node, sessionID))
      expect(restored?.id).toBe(sessionID)
      expect(restored?.location.directory).toBe(node as any)
      expect(restored?.location.workspaceID).toBe("wrk_core_created_nested" as any)
      expect(restored?.title).toBe("Nested updated from core JSONL")
      expect(restored?.time.archived).toBeUndefined()
      expect(DateTime.toEpochMillis(restored!.time.created)).toBe(10)
      expect(DateTime.toEpochMillis(restored!.time.updated)).toBe(110)
    }),
  )

  it.effect("replays moved events without trusting stale absolute directories", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "atree-core-moved-root-")))
      const node = path.join(root, "copied")
      const sessionID = SessionV2.ID.make("ses_core_moved_jsonl")
      yield* Effect.promise(() =>
        writeAtreeSession({
          root,
          directory: node,
          sessionID,
          title: "Moved core session",
          createdAt: 10,
          updatedAt: 20,
        }),
      )
      yield* Effect.promise(() =>
        appendSessionJsonl(node, sessionID, [
          {
            version: 1,
            at: 80,
            type: "session.next.agent.switched",
            sessionID,
            data: { agent: "build", timestamp: 80 },
          },
          {
            version: 1,
            at: 85,
            type: "session.next.model.switched",
            sessionID,
            data: { model: { providerID: "switch-provider", modelID: "switch-model", variant: "fast" }, timestamp: 85 },
          },
          {
            version: 1,
            at: 100,
            type: "session.next.moved",
            sessionID,
            location: { directory: "/stale/absolute/path", workspaceID: "wrk_core_moved" },
            subdirectory: "copied",
            timestamp: 90,
          },
        ]),
      )

      const restored = yield* Effect.promise(() => readSessionStore(node, sessionID))

      expect(restored?.location.directory).toBe(node as any)
      expect(restored?.location.workspaceID).toBe("wrk_core_moved" as any)
      expect(restored?.subpath).toBe("copied" as any)
      expect(restored?.agent).toBe("build" as any)
      expect(restored?.model).toMatchObject({ providerID: "switch-provider", id: "switch-model", variant: "fast" } as any)
      expect(DateTime.toEpochMillis(restored!.time.updated)).toBe(90)
    }),
  )

  it.effect("prefers an explicit directory hint over the global SQLite session row", () =>
    Effect.gen(function* () {
      const data = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "atree-core-hint-data-")))
      const root = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "atree-core-hint-root-")))
      const source = path.join(root, "source")
      const target = path.join(root, "target")
      const previousData = Global.Path.data
      ;(Global.Path as { data: string }).data = data
      yield* Effect.addFinalizer(() => Effect.sync(() => ((Global.Path as { data: string }).data = previousData)))
      yield* Effect.promise(() => mkdir(source, { recursive: true }))
      yield* Effect.promise(() => mkdir(target, { recursive: true }))
      const sessions = yield* SessionV2.Service
      const sessionID = SessionV2.ID.make("ses_core_directory_hint")
      yield* sessions.create({
        id: sessionID,
        location: Location.Ref.make({ directory: AbsolutePath.make(source) }),
      })
      yield* Effect.promise(() =>
        writeAtreeSession({
          root,
          directory: target,
          sessionID,
          title: "Target copy",
          createdAt: 100,
          updatedAt: 200,
        }),
      )
      yield* Effect.promise(() =>
        appendSessionJsonl(target, sessionID, [
          {
            type: "message.updated",
            message: {
              id: "msg_core_target_user",
              role: "user",
              time: { created: 210 },
            },
          },
          {
            type: "message.part.updated",
            part: {
              id: "prt_core_target_user",
              messageID: "msg_core_target_user",
              type: "text",
              text: "hello from target copy",
            },
          },
        ]),
      )

      const hinted = yield* sessions.get(sessionID, { directory: AbsolutePath.make(target) })
      const messages = yield* sessions.messages({
        sessionID,
        directory: AbsolutePath.make(target),
        order: "asc",
      })
      const context = yield* sessions.context(sessionID, { directory: AbsolutePath.make(target) })

      expect(hinted.title).toBe("Target copy")
      expect(hinted.location.directory).toBe(AbsolutePath.make(target))
      expect(messages).toHaveLength(1)
      expect(messages[0]).toMatchObject({
        id: "msg_core_target_user",
        type: "user",
        text: "hello from target copy",
      })
      expect(context.map((message) => message.id)).toEqual([messages[0]!.id])
    }),
  )

  it.effect("prefers a file-backed session from the persisted root over a stale SQLite directory row", () =>
    Effect.gen(function* () {
      const data = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "atree-core-store-data-")))
      const root = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "atree-core-store-root-")))
      const source = path.join(root, "source")
      const target = path.join(root, "target")
      const previousData = Global.Path.data
      ;(Global.Path as { data: string }).data = data
      yield* Effect.addFinalizer(() => Effect.sync(() => ((Global.Path as { data: string }).data = previousData)))
      yield* Effect.promise(() => mkdir(source, { recursive: true }))
      yield* Effect.promise(() => mkdir(target, { recursive: true }))

      const sessions = yield* SessionV2.Service
      const sessionID = SessionV2.ID.make("ses_core_store_stale_directory")
      const created = yield* sessions.create({
        id: sessionID,
        location: Location.Ref.make({ directory: AbsolutePath.make(source) }),
      })
      yield* Effect.promise(() =>
        rm(path.join(source, ".agents", "atree", "sessions", created.id), { recursive: true, force: true }),
      )
      yield* Effect.promise(() =>
        writeAtreeSession({
          root,
          directory: target,
          sessionID,
          title: "Recovered from root",
          createdAt: 100,
          updatedAt: 200,
        }),
      )

      const loaded = yield* sessions.get(sessionID)

      expect(loaded.title).toBe("Recovered from root")
      expect(loaded.location.directory).toBe(AbsolutePath.make(yield* Effect.promise(() => realpath(target))))
    }),
  )

  it.effect("reads file-backed session.jsonl messages through v2 APIs", () =>
    Effect.gen(function* () {
      const data = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "atree-core-data-")))
      const root = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "atree-core-root-")))
      const node = path.join(root, "inbox")
      const previousData = Global.Path.data
      ;(Global.Path as { data: string }).data = data
      yield* Effect.addFinalizer(() => Effect.sync(() => ((Global.Path as { data: string }).data = previousData)))

      yield* Effect.promise(() =>
        writeAtreeSession({
          root,
          directory: node,
          sessionID: "ses_core_messages",
          title: "Core messages",
          createdAt: 10,
          updatedAt: 20,
        }),
      )
      yield* Effect.promise(() =>
        appendSessionJsonl(node, "ses_core_messages", [
          {
            type: "message.updated",
            message: {
              id: "msg_core_user",
              role: "user",
              time: { created: 30 },
            },
          },
          {
            type: "message.part.updated",
            part: {
              id: "prt_core_user",
              messageID: "msg_core_user",
              type: "text",
              text: "hello from session.jsonl",
            },
          },
        ]),
      )

      const sessions = yield* SessionV2.Service
      const sessionID = SessionV2.ID.make("ses_core_messages")
      const messages = yield* sessions.messages({ sessionID, order: "asc" })
      const context = yield* sessions.context(sessionID)

      expect(messages).toHaveLength(1)
      expect(messages[0]).toMatchObject({ id: "msg_core_user", type: "user", text: "hello from session.jsonl" })
      expect(context.map((message) => message.id)).toEqual([messages[0]!.id])
    }),
  )

  it.effect("reads nested session.jsonl message event data through v2 APIs", () =>
    Effect.gen(function* () {
      const data = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "atree-core-nested-messages-data-")))
      const root = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "atree-core-nested-messages-root-")))
      const node = path.join(root, "inbox")
      const previousData = Global.Path.data
      ;(Global.Path as { data: string }).data = data
      yield* Effect.addFinalizer(() => Effect.sync(() => ((Global.Path as { data: string }).data = previousData)))

      yield* Effect.promise(() =>
        writeAtreeSession({
          root,
          directory: node,
          sessionID: "ses_core_nested_messages",
          title: "Core nested messages",
          createdAt: 10,
          updatedAt: 20,
        }),
      )
      yield* Effect.promise(() =>
        appendSessionJsonl(node, "ses_core_nested_messages", [
          {
            type: "message.updated",
            data: {
              message: {
                id: "msg_core_nested_user",
                role: "user",
                time: { created: 30 },
              },
            },
          },
          {
            type: "message.part.updated",
            data: {
              part: {
                id: "prt_core_nested_user",
                messageID: "msg_core_nested_user",
                type: "text",
                text: "nested",
              },
            },
          },
          {
            type: "message.part.delta",
            data: {
              messageID: "msg_core_nested_user",
              partID: "prt_core_nested_user",
              field: "text",
              delta: " event data",
            },
          },
        ]),
      )

      const sessions = yield* SessionV2.Service
      const sessionID = SessionV2.ID.make("ses_core_nested_messages")
      const messages = yield* sessions.messages({ sessionID, order: "asc" })
      const context = yield* sessions.context(sessionID)

      expect(messages).toHaveLength(1)
      expect(messages[0]).toMatchObject({ id: "msg_core_nested_user", type: "user", text: "nested event data" })
      expect(context.map((message) => message.id)).toEqual([messages[0]!.id])
    }),
  )

  storeIt.effect("loads core SessionStore context from file-backed session.jsonl", () =>
    Effect.gen(function* () {
      const data = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "atree-core-store-data-")))
      const root = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "atree-core-store-root-")))
      const node = path.join(root, "inbox")
      const previousData = Global.Path.data
      ;(Global.Path as { data: string }).data = data
      yield* Effect.addFinalizer(() => Effect.sync(() => ((Global.Path as { data: string }).data = previousData)))

      yield* Effect.promise(() =>
        writeAtreeSession({
          root,
          directory: node,
          sessionID: "ses_core_store_context",
          title: "Core store context",
          createdAt: 10,
          updatedAt: 20,
        }),
      )
      yield* Effect.promise(() =>
        appendSessionJsonl(node, "ses_core_store_context", [
          {
            type: "message.updated",
            message: {
              id: "msg_core_store_context",
              role: "user",
              time: { created: 30 },
            },
          },
          {
            type: "message.part.updated",
            part: {
              id: "prt_core_store_context",
              messageID: "msg_core_store_context",
              type: "text",
              text: "context from file-backed store",
            },
          },
        ]),
      )

      const store = yield* SessionStore.Service
      const context = yield* store.context(SessionV2.ID.make("ses_core_store_context"))

      expect(context).toHaveLength(1)
      expect(context[0]).toMatchObject({
        id: "msg_core_store_context",
        type: "user",
        text: "context from file-backed store",
      })
    }),
  )

  storeIt.effect("loads core SessionStore runner context from file-backed session.jsonl", () =>
    Effect.gen(function* () {
      const data = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "atree-core-runner-context-data-")))
      const root = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "atree-core-runner-context-root-")))
      const node = path.join(root, "inbox")
      const previousData = Global.Path.data
      ;(Global.Path as { data: string }).data = data
      yield* Effect.addFinalizer(() => Effect.sync(() => ((Global.Path as { data: string }).data = previousData)))

      yield* Effect.promise(() =>
        writeAtreeSession({
          root,
          directory: node,
          sessionID: "ses_core_runner_context",
          title: "Core runner context",
          createdAt: 10,
          updatedAt: 20,
        }),
      )
      yield* Effect.promise(() =>
        appendSessionJsonl(node, "ses_core_runner_context", [
          {
            type: "message.updated",
            message: {
              id: "msg_core_runner_context",
              role: "user",
              time: { created: 30 },
            },
          },
          {
            type: "message.part.updated",
            part: {
              id: "prt_core_runner_context",
              messageID: "msg_core_runner_context",
              type: "text",
              text: "runner context from file-backed store",
            },
          },
        ]),
      )

      const store = yield* SessionStore.Service
      const context = yield* store.runnerContext(SessionV2.ID.make("ses_core_runner_context"), 0)

      expect(context).toHaveLength(1)
      expect(context[0]).toMatchObject({
        id: "msg_core_runner_context",
        type: "user",
        text: "runner context from file-backed store",
      })
    }),
  )

  storeIt.effect("loads a core SessionStore message from file-backed session.jsonl", () =>
    Effect.gen(function* () {
      const data = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "atree-core-store-message-data-")))
      const root = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "atree-core-store-message-root-")))
      const node = path.join(root, "inbox")
      const previousData = Global.Path.data
      ;(Global.Path as { data: string }).data = data
      yield* Effect.addFinalizer(() => Effect.sync(() => ((Global.Path as { data: string }).data = previousData)))

      yield* Effect.promise(() =>
        writeAtreeSession({
          root,
          directory: node,
          sessionID: "ses_core_store_message",
          title: "Core store message",
          createdAt: 10,
          updatedAt: 20,
        }),
      )
      yield* Effect.promise(() =>
        appendSessionJsonl(node, "ses_core_store_message", [
          {
            type: "message.updated",
            message: {
              id: "msg_core_store_message",
              role: "user",
              time: { created: 30 },
            },
          },
          {
            type: "message.part.updated",
            part: {
              id: "prt_core_store_message",
              messageID: "msg_core_store_message",
              type: "text",
              text: "message from file-backed store",
            },
          },
        ]),
      )

      const store = yield* SessionStore.Service
      const result = yield* store.message(SessionMessage.ID.make("msg_core_store_message"))

      expect(result?.sessionID).toBe(SessionV2.ID.make("ses_core_store_message"))
      expect(result?.message).toMatchObject({
        id: "msg_core_store_message",
        type: "user",
        text: "message from file-backed store",
      })
    }),
  )

  storeIt.effect("prefers file-backed messages over stale SQLite message rows", () =>
    Effect.gen(function* () {
      const data = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "atree-core-store-message-data-")))
      const root = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "atree-core-store-message-root-")))
      const source = path.join(root, "source")
      const target = path.join(root, "target")
      const previousData = Global.Path.data
      ;(Global.Path as { data: string }).data = data
      yield* Effect.addFinalizer(() => Effect.sync(() => ((Global.Path as { data: string }).data = previousData)))

      const sessionID = "ses_core_store_message_stale"
      const messageID = "msg_core_store_message_stale"
      yield* Effect.promise(() =>
        writeAtreeSession({
          root,
          directory: source,
          sessionID,
          title: "Source stale",
          createdAt: 10,
          updatedAt: 20,
        }),
      )
      yield* Effect.promise(() =>
        writeAtreeSession({
          root,
          directory: target,
          sessionID,
          title: "Target current",
          createdAt: 30,
          updatedAt: 40,
        }),
      )
      yield* Effect.promise(() =>
        appendSessionJsonl(target, sessionID, [
          {
            type: "message.updated",
            message: {
              id: messageID,
              role: "user",
              time: { created: 50 },
            },
          },
          {
            type: "message.part.updated",
            part: {
              id: "prt_core_store_message_current",
              messageID,
              type: "text",
              text: "current file-backed message",
            },
          },
        ]),
      )

      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({
          id: "global",
          worktree: source,
          vcs: null,
          name: "Global",
          icon_url: null,
          icon_url_override: null,
          icon_color: null,
          time_created: 10,
          time_updated: 10,
          time_initialized: null,
          sandboxes: [],
          commands: null,
        } as unknown as typeof ProjectTable.$inferInsert)
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: SessionV2.ID.make(sessionID),
          project_id: "global",
          workspace_id: null,
          parent_id: null,
          slug: sessionID,
          directory: source,
          path: ".",
          title: "Stale SQLite session",
          version: "test",
          share_url: null,
          summary_additions: null,
          summary_deletions: null,
          summary_files: null,
          summary_diffs: null,
          metadata: {},
          cost: 0,
          tokens_input: 0,
          tokens_output: 0,
          tokens_reasoning: 0,
          tokens_cache_read: 0,
          tokens_cache_write: 0,
          revert: null,
          permission: null,
          agent: null,
          model: null,
          time_created: 10,
          time_updated: 10,
          time_compacting: null,
          time_archived: null,
        } as typeof SessionTable.$inferInsert)
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionMessageTable)
        .values({
          id: SessionMessage.ID.make(messageID),
          session_id: SessionV2.ID.make(sessionID),
          type: "user",
          seq: 0,
          time_created: 10,
          time_updated: 10,
          data: {
            text: "stale sqlite message",
            files: [],
            agents: {},
            time: { created: 10 },
          },
        } as typeof SessionMessageTable.$inferInsert)
        .run()
        .pipe(Effect.orDie)

      const store = yield* SessionStore.Service
      const result = yield* store.message(SessionMessage.ID.make(messageID))

      expect(result?.sessionID).toBe(SessionV2.ID.make(sessionID))
      expect(result?.message).toMatchObject({
        id: messageID,
        type: "user",
        text: "current file-backed message",
      })
    }),
  )

  it.effect("records v2 prompts into file-backed session.jsonl", () =>
    Effect.gen(function* () {
      const data = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "atree-core-data-")))
      const root = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "atree-core-root-")))
      const node = path.join(root, "inbox")
      const previousData = Global.Path.data
      ;(Global.Path as { data: string }).data = data
      yield* Effect.addFinalizer(() => Effect.sync(() => ((Global.Path as { data: string }).data = previousData)))

      yield* Effect.promise(() =>
        writeAtreeSession({
          root,
          directory: node,
          sessionID: "ses_core_prompt",
          title: "Core prompt",
          createdAt: 10,
          updatedAt: 20,
        }),
      )

      const sessions = yield* SessionV2.Service
      const sessionID = SessionV2.ID.make("ses_core_prompt")
      const admitted = yield* sessions.prompt({
        sessionID,
        id: SessionMessage.ID.make("msg_core_prompt"),
        prompt: new Prompt({ text: "record this prompt" }),
        resume: false,
      })
      const messages = yield* sessions.messages({ sessionID, order: "asc" })

      expect(admitted.id).toBe(SessionMessage.ID.make("msg_core_prompt"))
      expect(messages).toHaveLength(1)
      expect(messages[0]).toMatchObject({ id: "msg_core_prompt", type: "user", text: "record this prompt" })
    }),
  )

  it.effect("materializes v2 prompt files into file-backed session assets", () =>
    Effect.gen(function* () {
      const data = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "atree-core-data-")))
      const root = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "atree-core-root-")))
      const node = path.join(root, "inbox")
      const previousData = Global.Path.data
      ;(Global.Path as { data: string }).data = data
      yield* Effect.addFinalizer(() => Effect.sync(() => ((Global.Path as { data: string }).data = previousData)))

      yield* Effect.promise(() =>
        writeAtreeSession({
          root,
          directory: node,
          sessionID: "ses_core_prompt_file",
          title: "Core prompt file",
          createdAt: 10,
          updatedAt: 20,
        }),
      )

      const sessions = yield* SessionV2.Service
      const sessionID = SessionV2.ID.make("ses_core_prompt_file")
      yield* sessions.prompt({
        sessionID,
        id: SessionMessage.ID.make("msg_core_prompt_file"),
        prompt: new Prompt({
          text: "record this file",
          files: [
            new FileAttachment({
              uri: "data:text/plain;base64,aGVsbG8gZmlsZQ==",
              mime: "text/plain",
              name: "hello.txt",
            }),
          ],
        }),
        resume: false,
      })

      const sessionRoot = path.join(node, ".agents", "atree", "sessions", "ses_core_prompt_file")
      const raw = yield* Effect.promise(() => readFile(path.join(sessionRoot, "session.jsonl"), "utf8"))
      const assets = yield* Effect.promise(() => readdir(path.join(sessionRoot, "assets")))
      const messages = yield* sessions.messages({ sessionID, order: "asc" })

      expect(raw).not.toContain("data:text/plain")
      expect(assets).toHaveLength(1)
      expect(messages).toHaveLength(1)
      expect(messages[0]).toMatchObject({
        id: "msg_core_prompt_file",
        type: "user",
        text: "record this file",
        files: [{ uri: "data:text/plain;base64,aGVsbG8gZmlsZQ==", mime: "text/plain", name: "hello.txt" }],
      })
    }),
  )

  it.effect("detects file-backed prompt conflicts across files", () =>
    Effect.gen(function* () {
      const data = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "atree-core-data-")))
      const root = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "atree-core-root-")))
      const node = path.join(root, "inbox")
      const previousData = Global.Path.data
      ;(Global.Path as { data: string }).data = data
      yield* Effect.addFinalizer(() => Effect.sync(() => ((Global.Path as { data: string }).data = previousData)))

      yield* Effect.promise(() =>
        writeAtreeSession({
          root,
          directory: node,
          sessionID: "ses_core_prompt_conflict",
          title: "Core prompt conflict",
          createdAt: 10,
          updatedAt: 20,
        }),
      )

      const sessions = yield* SessionV2.Service
      const sessionID = SessionV2.ID.make("ses_core_prompt_conflict")
      const messageID = SessionMessage.ID.make("msg_core_prompt_conflict")
      const firstPrompt = new Prompt({
        text: "same text",
        files: [new FileAttachment({ uri: "data:text/plain;base64,Zmlyc3Q=", mime: "text/plain", name: "same.txt" })],
      })
      const secondPrompt = new Prompt({
        text: "same text",
        files: [new FileAttachment({ uri: "data:text/plain;base64,c2Vjb25k", mime: "text/plain", name: "same.txt" })],
      })

      const first = yield* sessions.prompt({ sessionID, id: messageID, prompt: firstPrompt, resume: false })
      const replayed = yield* sessions.prompt({ sessionID, id: messageID, prompt: firstPrompt, resume: false })
      const conflict = yield* sessions
        .prompt({ sessionID, id: messageID, prompt: secondPrompt, resume: false })
        .pipe(Effect.flip)

      expect(first.id).toBe(messageID)
      expect(replayed.id).toBe(messageID)
      expect(conflict._tag).toBe("Session.PromptConflictError")
    }),
  )

  it.effect("replays text part deltas from file-backed session.jsonl", () =>
    Effect.gen(function* () {
      const data = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "atree-core-data-")))
      const root = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "atree-core-root-")))
      const node = path.join(root, "inbox")
      const previousData = Global.Path.data
      ;(Global.Path as { data: string }).data = data
      yield* Effect.addFinalizer(() => Effect.sync(() => ((Global.Path as { data: string }).data = previousData)))

      yield* Effect.promise(() =>
        writeAtreeSession({
          root,
          directory: node,
          sessionID: "ses_core_delta",
          title: "Core delta",
          createdAt: 10,
          updatedAt: 20,
        }),
      )
      yield* Effect.promise(() =>
        appendSessionJsonl(node, "ses_core_delta", [
          {
            type: "message.updated",
            message: {
              id: "msg_core_assistant_delta",
              role: "assistant",
              model: { providerID: "test", modelID: "test", variant: "default" },
              time: { created: 30 },
            },
          },
          {
            type: "message.part.updated",
            part: {
              id: "prt_core_delta",
              messageID: "msg_core_assistant_delta",
              type: "text",
              text: "",
            },
          },
          {
            type: "message.part.delta",
            messageID: "msg_core_assistant_delta",
            partID: "prt_core_delta",
            field: "text",
            delta: "hello ",
          },
          {
            type: "message.part.delta",
            messageID: "msg_core_assistant_delta",
            partID: "prt_core_delta",
            field: "text",
            delta: "delta",
          },
        ]),
      )

      const sessions = yield* SessionV2.Service
      const messages = yield* sessions.messages({ sessionID: SessionV2.ID.make("ses_core_delta"), order: "asc" })

      expect(messages).toHaveLength(1)
      expect(messages[0]).toMatchObject({
        id: "msg_core_assistant_delta",
        type: "assistant",
        content: [{ type: "text", text: "hello delta" }],
      })
    }),
  )

  it.effect("attaches orphan parts when the message arrives later", () =>
    Effect.gen(function* () {
      const data = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "atree-core-data-")))
      const root = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "atree-core-root-")))
      const node = path.join(root, "inbox")
      const previousData = Global.Path.data
      ;(Global.Path as { data: string }).data = data
      yield* Effect.addFinalizer(() => Effect.sync(() => ((Global.Path as { data: string }).data = previousData)))

      yield* Effect.promise(() =>
        writeAtreeSession({
          root,
          directory: node,
          sessionID: "ses_core_orphan_part",
          title: "Core orphan part",
          createdAt: 10,
          updatedAt: 20,
        }),
      )
      yield* Effect.promise(() =>
        appendSessionJsonl(node, "ses_core_orphan_part", [
          {
            type: "message.part.updated",
            part: {
              id: "prt_core_orphan",
              messageID: "msg_core_orphan",
              type: "text",
              text: "hello ",
            },
          },
          {
            type: "message.part.delta",
            messageID: "msg_core_orphan",
            partID: "prt_core_orphan",
            field: "text",
            delta: "orphan",
          },
          {
            type: "message.updated",
            message: {
              id: "msg_core_orphan",
              role: "assistant",
              model: { providerID: "test", modelID: "test", variant: "default" },
              time: { created: 30 },
            },
          },
        ]),
      )

      const sessions = yield* SessionV2.Service
      const messages = yield* sessions.messages({ sessionID: SessionV2.ID.make("ses_core_orphan_part"), order: "asc" })

      expect(messages).toHaveLength(1)
      expect(messages[0]).toMatchObject({
        id: "msg_core_orphan",
        type: "assistant",
        content: [{ type: "text", text: "hello orphan" }],
      })
    }),
  )

  it.effect("restores assistant reasoning parts from file-backed session.jsonl", () =>
    Effect.gen(function* () {
      const data = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "atree-core-data-")))
      const root = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "atree-core-root-")))
      const node = path.join(root, "inbox")
      const previousData = Global.Path.data
      ;(Global.Path as { data: string }).data = data
      yield* Effect.addFinalizer(() => Effect.sync(() => ((Global.Path as { data: string }).data = previousData)))

      yield* Effect.promise(() =>
        writeAtreeSession({
          root,
          directory: node,
          sessionID: "ses_core_reasoning",
          title: "Core reasoning",
          createdAt: 10,
          updatedAt: 20,
        }),
      )
      yield* Effect.promise(() =>
        appendSessionJsonl(node, "ses_core_reasoning", [
          {
            type: "message.updated",
            message: {
              id: "msg_core_reasoning",
              role: "assistant",
              model: { providerID: "test", modelID: "test", variant: "default" },
              time: { created: 30 },
            },
          },
          {
            type: "message.part.updated",
            part: {
              id: "prt_core_reasoning",
              messageID: "msg_core_reasoning",
              type: "reasoning",
              text: "Think carefully",
              metadata: { anthropic: { signature: "sig_1" } },
            },
          },
          {
            type: "message.part.updated",
            part: {
              id: "prt_core_reasoning_text",
              messageID: "msg_core_reasoning",
              type: "text",
              text: "Final answer",
            },
          },
        ]),
      )

      const sessions = yield* SessionV2.Service
      const messages = yield* sessions.messages({ sessionID: SessionV2.ID.make("ses_core_reasoning"), order: "asc" })

      expect(messages).toHaveLength(1)
      expect(messages[0]).toMatchObject({
        id: "msg_core_reasoning",
        type: "assistant",
        content: [
          { type: "text", text: "Final answer" },
          { type: "reasoning", id: "prt_core_reasoning", text: "Think carefully" },
        ],
      })
      if (messages[0]?.type === "assistant") {
        expect(messages[0].content[1]).toMatchObject({
          providerMetadata: { anthropic: { signature: "sig_1" } },
        })
      }
    }),
  )

  it.effect("restores direct session events from file-backed session.jsonl", () =>
    Effect.gen(function* () {
      const data = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "atree-core-data-")))
      const root = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "atree-core-root-")))
      const node = path.join(root, "inbox")
      const previousData = Global.Path.data
      ;(Global.Path as { data: string }).data = data
      yield* Effect.addFinalizer(() => Effect.sync(() => ((Global.Path as { data: string }).data = previousData)))

      yield* Effect.promise(() =>
        writeAtreeSession({
          root,
          directory: node,
          sessionID: "ses_core_direct_events",
          title: "Core direct events",
          createdAt: 10,
          updatedAt: 20,
        }),
      )
      yield* Effect.promise(() =>
        appendSessionJsonl(node, "ses_core_direct_events", [
          {
            type: "session.next.agent.switched",
            messageID: "msg_core_agent",
            agent: "build",
            timestamp: 30,
          },
          {
            type: "session.next.model.switched",
            messageID: "msg_core_model",
            model: { providerID: "test", id: "model-a", variant: "default" },
            timestamp: 31,
          },
          {
            type: "session.next.context.updated",
            messageID: "msg_core_context",
            text: "System context",
            timestamp: 32,
          },
          {
            type: "session.next.synthetic",
            messageID: "msg_core_synthetic",
            text: "Synthetic context",
            timestamp: 33,
          },
        ]),
      )

      const sessions = yield* SessionV2.Service
      const sessionID = SessionV2.ID.make("ses_core_direct_events")
      const messages = yield* sessions.messages({ sessionID, order: "asc" })
      const context = yield* sessions.context(sessionID)

      expect(messages).toMatchObject([
        { id: "msg_core_agent", type: "agent-switched", agent: "build" },
        {
          id: "msg_core_model",
          type: "model-switched",
          model: { providerID: "test", id: "model-a", variant: "default" },
        },
        { id: "msg_core_context", type: "system", text: "System context" },
        { id: "msg_core_synthetic", type: "synthetic", text: "Synthetic context", sessionID },
      ])
      expect(context.map((message) => message.id)).toEqual(messages.map((message) => message.id))
      expect(DateTime.toEpochMillis(messages[0]!.time.created)).toBe(30)
    }),
  )

  it.effect("restores event-backed prompts from file-backed session.jsonl", () =>
    Effect.gen(function* () {
      const data = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "atree-core-data-")))
      const root = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "atree-core-root-")))
      const node = path.join(root, "inbox")
      const previousData = Global.Path.data
      ;(Global.Path as { data: string }).data = data
      yield* Effect.addFinalizer(() => Effect.sync(() => ((Global.Path as { data: string }).data = previousData)))

      yield* Effect.promise(() =>
        writeAtreeSession({
          root,
          directory: node,
          sessionID: "ses_core_event_prompted",
          title: "Core event prompted",
          createdAt: 10,
          updatedAt: 20,
        }),
      )
      yield* Effect.promise(() =>
        mkdir(path.join(node, ".agents", "atree", "sessions", "ses_core_event_prompted", "assets"), {
          recursive: true,
        }),
      )
      yield* Effect.promise(() =>
        writeFile(
          path.join(node, ".agents", "atree", "sessions", "ses_core_event_prompted", "assets", "prompt.txt"),
          "prompt asset",
        ),
      )
      yield* Effect.promise(() =>
        appendSessionJsonl(node, "ses_core_event_prompted", [
          {
            type: "session.next.prompted.1",
            messageID: "msg_core_event_prompted",
            prompt: {
              text: "Prompt text",
              files: [{ uri: "assets/prompt.txt", mime: "text/plain", name: "prompt.txt" }],
              agents: [{ name: "build" }],
            },
            delivery: "steer",
            timestamp: 30,
          },
        ]),
      )

      const sessions = yield* SessionV2.Service
      const messages = yield* sessions.messages({
        sessionID: SessionV2.ID.make("ses_core_event_prompted"),
        order: "asc",
      })

      expect(messages).toHaveLength(1)
      expect(messages[0]).toMatchObject({
        id: "msg_core_event_prompted",
        type: "user",
        text: "Prompt text",
        files: [{ uri: "data:text/plain;base64,cHJvbXB0IGFzc2V0", mime: "text/plain", name: "prompt.txt" }],
        agents: [{ name: "build" }],
      })
      expect(DateTime.toEpochMillis(messages[0]!.time.created)).toBe(30)
    }),
  )

  it.effect("does not duplicate mixed event-backed prompts from file-backed session.jsonl", () =>
    Effect.gen(function* () {
      const data = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "atree-core-data-")))
      const root = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "atree-core-root-")))
      const node = path.join(root, "inbox")
      const previousData = Global.Path.data
      ;(Global.Path as { data: string }).data = data
      yield* Effect.addFinalizer(() => Effect.sync(() => ((Global.Path as { data: string }).data = previousData)))

      yield* Effect.promise(() =>
        writeAtreeSession({
          root,
          directory: node,
          sessionID: "ses_core_event_prompted_mixed",
          title: "Core event prompted mixed",
          createdAt: 10,
          updatedAt: 20,
        }),
      )
      yield* Effect.promise(() =>
        appendSessionJsonl(node, "ses_core_event_prompted_mixed", [
          {
            type: "message.updated",
            message: { id: "msg_core_event_prompted_mixed", role: "user", time: { created: 30 } },
          },
          {
            type: "message.part.updated",
            part: {
              id: "part_core_event_prompted_mixed",
              messageID: "msg_core_event_prompted_mixed",
              type: "text",
              text: "V1 prompt",
            },
          },
          {
            type: "session.next.prompted",
            messageID: "msg_core_event_prompted_mixed",
            prompt: { text: "Event prompt" },
            delivery: "steer",
            timestamp: 31,
          },
        ]),
      )

      const sessions = yield* SessionV2.Service
      const messages = yield* sessions.messages({
        sessionID: SessionV2.ID.make("ses_core_event_prompted_mixed"),
        order: "asc",
      })

      expect(messages).toHaveLength(1)
      expect(messages[0]).toMatchObject({
        id: "msg_core_event_prompted_mixed",
        type: "user",
        text: "V1 prompt",
      })
    }),
  )

  it.effect("restores event-backed assistant steps from file-backed session.jsonl", () =>
    Effect.gen(function* () {
      const data = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "atree-core-data-")))
      const root = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "atree-core-root-")))
      const node = path.join(root, "inbox")
      const previousData = Global.Path.data
      ;(Global.Path as { data: string }).data = data
      yield* Effect.addFinalizer(() => Effect.sync(() => ((Global.Path as { data: string }).data = previousData)))

      yield* Effect.promise(() =>
        writeAtreeSession({
          root,
          directory: node,
          sessionID: "ses_core_event_assistant",
          title: "Core event assistant",
          createdAt: 10,
          updatedAt: 20,
        }),
      )
      yield* Effect.promise(() =>
        appendSessionJsonl(node, "ses_core_event_assistant", [
          {
            type: "session.next.step.started",
            assistantMessageID: "msg_core_event_assistant",
            agent: "build",
            model: { providerID: "test", id: "model-a", variant: "default" },
            snapshot: "snapshot-start",
            timestamp: 30,
          },
          {
            type: "session.next.reasoning.ended",
            assistantMessageID: "msg_core_event_assistant",
            reasoningID: "reasoning_core_event",
            text: "Think",
            providerMetadata: { anthropic: { signature: "sig_event" } },
            timestamp: 31,
          },
          {
            type: "session.next.text.ended",
            assistantMessageID: "msg_core_event_assistant",
            textID: "text_core_event",
            text: "Final answer",
            timestamp: 32,
          },
          {
            type: "session.next.step.ended.2",
            assistantMessageID: "msg_core_event_assistant",
            finish: "stop",
            cost: 0.25,
            tokens: { input: 1, output: 2, reasoning: 3, cache: { read: 4, write: 5 } },
            snapshot: "snapshot-end",
            timestamp: 40,
          },
        ]),
      )

      const sessions = yield* SessionV2.Service
      const messages = yield* sessions.messages({
        sessionID: SessionV2.ID.make("ses_core_event_assistant"),
        order: "asc",
      })

      expect(messages).toHaveLength(1)
      expect(messages[0]).toMatchObject({
        id: "msg_core_event_assistant",
        type: "assistant",
        agent: "build",
        model: { providerID: "test", id: "model-a", variant: "default" },
        content: [
          { type: "reasoning", id: "reasoning_core_event", text: "Think" },
          { type: "text", id: "text_core_event", text: "Final answer" },
        ],
        snapshot: { start: "snapshot-start", end: "snapshot-end" },
        finish: "stop",
        cost: 0.25,
        tokens: { input: 1, output: 2, reasoning: 3, cache: { read: 4, write: 5 } },
      })
      if (messages[0]?.type === "assistant") {
        expect(DateTime.toEpochMillis(messages[0].time.completed!)).toBe(40)
        expect(messages[0].content[0]).toMatchObject({
          providerMetadata: { anthropic: { signature: "sig_event" } },
        })
      }
    }),
  )

  it.effect("restores failed event-backed assistant steps from file-backed session.jsonl", () =>
    Effect.gen(function* () {
      const data = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "atree-core-data-")))
      const root = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "atree-core-root-")))
      const node = path.join(root, "inbox")
      const previousData = Global.Path.data
      ;(Global.Path as { data: string }).data = data
      yield* Effect.addFinalizer(() => Effect.sync(() => ((Global.Path as { data: string }).data = previousData)))

      yield* Effect.promise(() =>
        writeAtreeSession({
          root,
          directory: node,
          sessionID: "ses_core_event_assistant_failed",
          title: "Core event assistant failed",
          createdAt: 10,
          updatedAt: 20,
        }),
      )
      yield* Effect.promise(() =>
        appendSessionJsonl(node, "ses_core_event_assistant_failed", [
          {
            type: "session.next.step.started",
            assistantMessageID: "msg_core_event_assistant_failed",
            agent: "build",
            model: { providerID: "test", id: "model-a", variant: "default" },
            timestamp: 30,
          },
          {
            type: "session.next.step.failed",
            assistantMessageID: "msg_core_event_assistant_failed",
            error: { type: "unknown", message: "model failed" },
            timestamp: 40,
          },
        ]),
      )

      const sessions = yield* SessionV2.Service
      const messages = yield* sessions.messages({
        sessionID: SessionV2.ID.make("ses_core_event_assistant_failed"),
        order: "asc",
      })

      expect(messages).toHaveLength(1)
      expect(messages[0]).toMatchObject({
        id: "msg_core_event_assistant_failed",
        type: "assistant",
        finish: "error",
        error: { type: "unknown", message: "model failed" },
      })
    }),
  )

  it.effect("does not duplicate mixed event-backed assistant steps from file-backed session.jsonl", () =>
    Effect.gen(function* () {
      const data = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "atree-core-data-")))
      const root = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "atree-core-root-")))
      const node = path.join(root, "inbox")
      const previousData = Global.Path.data
      ;(Global.Path as { data: string }).data = data
      yield* Effect.addFinalizer(() => Effect.sync(() => ((Global.Path as { data: string }).data = previousData)))

      yield* Effect.promise(() =>
        writeAtreeSession({
          root,
          directory: node,
          sessionID: "ses_core_event_assistant_mixed",
          title: "Core event assistant mixed",
          createdAt: 10,
          updatedAt: 20,
        }),
      )
      yield* Effect.promise(() =>
        appendSessionJsonl(node, "ses_core_event_assistant_mixed", [
          {
            type: "message.updated",
            message: {
              id: "msg_core_event_assistant_mixed",
              role: "assistant",
              model: { providerID: "test", modelID: "model-a", variant: "default" },
              time: { created: 30 },
            },
          },
          {
            type: "message.part.updated",
            part: {
              id: "part_core_event_assistant_mixed",
              messageID: "msg_core_event_assistant_mixed",
              type: "text",
              text: "V1 answer",
            },
          },
          {
            type: "session.next.step.started",
            assistantMessageID: "msg_core_event_assistant_mixed",
            agent: "build",
            model: { providerID: "test", id: "model-a", variant: "default" },
            timestamp: 31,
          },
          {
            type: "session.next.text.ended",
            assistantMessageID: "msg_core_event_assistant_mixed",
            textID: "text_core_event_assistant_mixed",
            text: "Event answer",
            timestamp: 32,
          },
        ]),
      )

      const sessions = yield* SessionV2.Service
      const messages = yield* sessions.messages({
        sessionID: SessionV2.ID.make("ses_core_event_assistant_mixed"),
        order: "asc",
      })

      expect(messages).toHaveLength(1)
      expect(messages[0]).toMatchObject({
        id: "msg_core_event_assistant_mixed",
        type: "assistant",
        content: [{ type: "text", text: "V1 answer" }],
      })
    }),
  )

  it.effect("removes event-backed assistant steps from file-backed session.jsonl", () =>
    Effect.gen(function* () {
      const data = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "atree-core-data-")))
      const root = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "atree-core-root-")))
      const node = path.join(root, "inbox")
      const previousData = Global.Path.data
      ;(Global.Path as { data: string }).data = data
      yield* Effect.addFinalizer(() => Effect.sync(() => ((Global.Path as { data: string }).data = previousData)))

      yield* Effect.promise(() =>
        writeAtreeSession({
          root,
          directory: node,
          sessionID: "ses_core_event_assistant_removed",
          title: "Core event assistant removed",
          createdAt: 10,
          updatedAt: 20,
        }),
      )
      yield* Effect.promise(() =>
        appendSessionJsonl(node, "ses_core_event_assistant_removed", [
          {
            type: "session.next.step.started",
            assistantMessageID: "msg_core_event_assistant_removed",
            agent: "build",
            model: { providerID: "test", id: "model-a", variant: "default" },
            timestamp: 30,
          },
          {
            type: "session.next.text.ended",
            assistantMessageID: "msg_core_event_assistant_removed",
            textID: "text_core_event_assistant_removed",
            text: "Removed answer",
            timestamp: 31,
          },
          {
            type: "message.removed",
            messageID: "msg_core_event_assistant_removed",
          },
        ]),
      )

      const sessions = yield* SessionV2.Service
      const messages = yield* sessions.messages({
        sessionID: SessionV2.ID.make("ses_core_event_assistant_removed"),
        order: "asc",
      })

      expect(messages).toHaveLength(0)
    }),
  )

  it.effect("restores event-backed completed tool calls from file-backed session.jsonl", () =>
    Effect.gen(function* () {
      const data = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "atree-core-data-")))
      const root = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "atree-core-root-")))
      const node = path.join(root, "inbox")
      const previousData = Global.Path.data
      ;(Global.Path as { data: string }).data = data
      yield* Effect.addFinalizer(() => Effect.sync(() => ((Global.Path as { data: string }).data = previousData)))

      yield* Effect.promise(() =>
        writeAtreeSession({
          root,
          directory: node,
          sessionID: "ses_core_event_tool_completed",
          title: "Core event tool completed",
          createdAt: 10,
          updatedAt: 20,
        }),
      )
      yield* Effect.promise(() =>
        appendSessionJsonl(node, "ses_core_event_tool_completed", [
          {
            type: "session.next.step.started",
            assistantMessageID: "msg_core_event_tool_completed",
            agent: "build",
            model: { providerID: "test", id: "model-a", variant: "default" },
            timestamp: 30,
          },
          {
            type: "session.next.tool.input.started",
            assistantMessageID: "msg_core_event_tool_completed",
            callID: "call_core_event_tool_completed",
            name: "bash",
            timestamp: 31,
          },
          {
            type: "session.next.tool.input.ended",
            assistantMessageID: "msg_core_event_tool_completed",
            callID: "call_core_event_tool_completed",
            text: '{"cmd":"echo hi"}',
            timestamp: 32,
          },
          {
            type: "session.next.tool.called",
            assistantMessageID: "msg_core_event_tool_completed",
            callID: "call_core_event_tool_completed",
            tool: "bash",
            input: { cmd: "echo hi" },
            provider: { executed: false, metadata: { test: { call: true } } },
            timestamp: 33,
          },
          {
            type: "session.next.tool.progress",
            assistantMessageID: "msg_core_event_tool_completed",
            callID: "call_core_event_tool_completed",
            structured: { phase: "running" },
            content: [{ type: "text", text: "running" }],
            timestamp: 34,
          },
          {
            type: "session.next.tool.success.1",
            assistantMessageID: "msg_core_event_tool_completed",
            callID: "call_core_event_tool_completed",
            structured: { exit: 0 },
            content: [{ type: "text", text: "ok" }],
            result: { ok: true },
            provider: { executed: true, metadata: { test: { result: true } } },
            timestamp: 35,
          },
        ]),
      )

      const sessions = yield* SessionV2.Service
      const messages = yield* sessions.messages({
        sessionID: SessionV2.ID.make("ses_core_event_tool_completed"),
        order: "asc",
      })

      expect(messages).toHaveLength(1)
      expect(messages[0]).toMatchObject({
        id: "msg_core_event_tool_completed",
        type: "assistant",
        content: [
          {
            type: "tool",
            id: "call_core_event_tool_completed",
            name: "bash",
            provider: {
              executed: true,
              metadata: { test: { call: true } },
              resultMetadata: { test: { result: true } },
            },
            state: {
              status: "completed",
              input: { cmd: "echo hi" },
              structured: { exit: 0 },
              content: [{ type: "text", text: "ok" }],
              outputPaths: [],
              result: { ok: true },
            },
          },
        ],
      })
      if (messages[0]?.type === "assistant" && messages[0].content[0]?.type === "tool") {
        expect(DateTime.toEpochMillis(messages[0].content[0].time.ran!)).toBe(33)
        expect(DateTime.toEpochMillis(messages[0].content[0].time.completed!)).toBe(35)
      }
    }),
  )

  it.effect("restores event-backed failed tool calls from file-backed session.jsonl", () =>
    Effect.gen(function* () {
      const data = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "atree-core-data-")))
      const root = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "atree-core-root-")))
      const node = path.join(root, "inbox")
      const previousData = Global.Path.data
      ;(Global.Path as { data: string }).data = data
      yield* Effect.addFinalizer(() => Effect.sync(() => ((Global.Path as { data: string }).data = previousData)))

      yield* Effect.promise(() =>
        writeAtreeSession({
          root,
          directory: node,
          sessionID: "ses_core_event_tool_failed",
          title: "Core event tool failed",
          createdAt: 10,
          updatedAt: 20,
        }),
      )
      yield* Effect.promise(() =>
        appendSessionJsonl(node, "ses_core_event_tool_failed", [
          {
            type: "session.next.step.started",
            assistantMessageID: "msg_core_event_tool_failed",
            agent: "build",
            model: { providerID: "test", id: "model-a", variant: "default" },
            timestamp: 30,
          },
          {
            type: "session.next.tool.input.started",
            assistantMessageID: "msg_core_event_tool_failed",
            callID: "call_core_event_tool_failed",
            name: "bash",
            timestamp: 31,
          },
          {
            type: "session.next.tool.failed",
            assistantMessageID: "msg_core_event_tool_failed",
            callID: "call_core_event_tool_failed",
            error: { type: "unknown", message: "tool failed" },
            result: "bad",
            provider: { executed: false, metadata: { test: { result: true } } },
            timestamp: 32,
          },
        ]),
      )

      const sessions = yield* SessionV2.Service
      const messages = yield* sessions.messages({
        sessionID: SessionV2.ID.make("ses_core_event_tool_failed"),
        order: "asc",
      })

      expect(messages).toHaveLength(1)
      expect(messages[0]).toMatchObject({
        id: "msg_core_event_tool_failed",
        type: "assistant",
        content: [
          {
            type: "tool",
            id: "call_core_event_tool_failed",
            name: "bash",
            provider: { executed: false, resultMetadata: { test: { result: true } } },
            state: {
              status: "error",
              error: { type: "unknown", message: "tool failed" },
              input: {},
              structured: {},
              content: [],
              result: "bad",
            },
          },
        ],
      })
    }),
  )

  it.effect("restores completed tool invocations from file-backed session.jsonl", () =>
    Effect.gen(function* () {
      const data = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "atree-core-data-")))
      const root = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "atree-core-root-")))
      const node = path.join(root, "inbox")
      const previousData = Global.Path.data
      ;(Global.Path as { data: string }).data = data
      yield* Effect.addFinalizer(() => Effect.sync(() => ((Global.Path as { data: string }).data = previousData)))

      yield* Effect.promise(() =>
        writeAtreeSession({
          root,
          directory: node,
          sessionID: "ses_core_tool_result",
          title: "Core tool result",
          createdAt: 10,
          updatedAt: 20,
        }),
      )
      yield* Effect.promise(() =>
        appendSessionJsonl(node, "ses_core_tool_result", [
          {
            type: "message.updated",
            message: {
              id: "msg_core_tool_result",
              role: "assistant",
              model: { providerID: "test", modelID: "test", variant: "default" },
              time: { created: 30 },
            },
          },
          {
            type: "message.part.updated",
            part: {
              id: "prt_core_tool_result",
              messageID: "msg_core_tool_result",
              type: "tool-invocation",
              toolInvocation: {
                state: "result",
                toolCallId: "call_core_read",
                toolName: "read",
                args: { filePath: "README.md" },
                result: "file contents",
              },
            },
          },
        ]),
      )

      const sessions = yield* SessionV2.Service
      const messages = yield* sessions.messages({ sessionID: SessionV2.ID.make("ses_core_tool_result"), order: "asc" })

      expect(messages).toHaveLength(1)
      expect(messages[0]).toMatchObject({
        id: "msg_core_tool_result",
        type: "assistant",
        content: [
          {
            type: "tool",
            id: "call_core_read",
            name: "read",
            state: {
              status: "completed",
              input: { filePath: "README.md" },
              content: [{ type: "text", text: "file contents" }],
              structured: {},
              result: "file contents",
            },
          },
        ],
      })
    }),
  )

  it.effect("restores pending and running tool invocations from file-backed session.jsonl", () =>
    Effect.gen(function* () {
      const data = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "atree-core-data-")))
      const root = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "atree-core-root-")))
      const node = path.join(root, "inbox")
      const previousData = Global.Path.data
      ;(Global.Path as { data: string }).data = data
      yield* Effect.addFinalizer(() => Effect.sync(() => ((Global.Path as { data: string }).data = previousData)))

      yield* Effect.promise(() =>
        writeAtreeSession({
          root,
          directory: node,
          sessionID: "ses_core_tool_inflight",
          title: "Core inflight tools",
          createdAt: 10,
          updatedAt: 20,
        }),
      )
      yield* Effect.promise(() =>
        appendSessionJsonl(node, "ses_core_tool_inflight", [
          {
            type: "message.updated",
            message: {
              id: "msg_core_tool_inflight",
              role: "assistant",
              model: { providerID: "test", modelID: "test", variant: "default" },
              time: { created: 30 },
            },
          },
          {
            type: "message.part.updated",
            part: {
              id: "prt_core_tool_partial",
              messageID: "msg_core_tool_inflight",
              type: "tool-invocation",
              toolInvocation: {
                state: "partial-call",
                toolCallId: "call_core_partial",
                toolName: "read",
                args: '{"filePath"',
              },
            },
          },
          {
            type: "message.part.updated",
            part: {
              id: "prt_core_tool_call",
              messageID: "msg_core_tool_inflight",
              type: "tool-invocation",
              toolInvocation: {
                state: "call",
                toolCallId: "call_core_running",
                toolName: "grep",
                args: { pattern: "atree" },
              },
            },
          },
          {
            type: "message.part.updated",
            part: {
              id: "prt_core_v1_pending",
              messageID: "msg_core_tool_inflight",
              type: "tool",
              tool: "bash",
              callID: "call_core_v1_pending",
              state: {
                status: "pending",
                input: { command: "pwd" },
                raw: '{"command":"pwd"}',
              },
            },
          },
          {
            type: "message.part.updated",
            part: {
              id: "prt_core_v1_running",
              messageID: "msg_core_tool_inflight",
              type: "tool",
              tool: "read",
              callID: "call_core_v1_running",
              state: {
                status: "running",
                input: { filePath: "README.md" },
                metadata: { title: "Read README.md" },
                time: { start: 31 },
              },
            },
          },
        ]),
      )

      const sessions = yield* SessionV2.Service
      const messages = yield* sessions.messages({
        sessionID: SessionV2.ID.make("ses_core_tool_inflight"),
        order: "asc",
      })

      expect(messages).toHaveLength(1)
      expect(messages[0]).toMatchObject({
        id: "msg_core_tool_inflight",
        type: "assistant",
        content: [
          { type: "tool", id: "call_core_partial", name: "read", state: { status: "pending", input: '{"filePath"' } },
          {
            type: "tool",
            id: "call_core_running",
            name: "grep",
            state: { status: "running", input: { pattern: "atree" }, structured: {}, content: [] },
          },
          {
            type: "tool",
            id: "call_core_v1_pending",
            name: "bash",
            state: { status: "pending", input: '{"command":"pwd"}' },
          },
          {
            type: "tool",
            id: "call_core_v1_running",
            name: "read",
            state: {
              status: "running",
              input: { filePath: "README.md" },
              structured: { title: "Read README.md" },
              content: [],
            },
          },
        ],
      })
      if (messages[0]?.type === "assistant" && messages[0].content[3]?.type === "tool") {
        expect(DateTime.toEpochMillis(messages[0].content[3].time.created)).toBe(31)
      }
    }),
  )

  it.effect("restores shell events from file-backed session.jsonl", () =>
    Effect.gen(function* () {
      const data = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "atree-core-data-")))
      const root = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "atree-core-root-")))
      const node = path.join(root, "inbox")
      const previousData = Global.Path.data
      ;(Global.Path as { data: string }).data = data
      yield* Effect.addFinalizer(() => Effect.sync(() => ((Global.Path as { data: string }).data = previousData)))

      yield* Effect.promise(() =>
        writeAtreeSession({
          root,
          directory: node,
          sessionID: "ses_core_shell",
          title: "Core shell",
          createdAt: 10,
          updatedAt: 20,
        }),
      )
      yield* Effect.promise(() =>
        appendSessionJsonl(node, "ses_core_shell", [
          {
            type: "session.next.shell.started",
            messageID: "msg_core_shell",
            callID: "call_core_shell",
            command: "pwd",
            timestamp: 30,
          },
          {
            type: "session.next.shell.ended",
            callID: "call_core_shell",
            output: "/workspace",
            timestamp: 40,
          },
        ]),
      )

      const sessions = yield* SessionV2.Service
      const messages = yield* sessions.messages({ sessionID: SessionV2.ID.make("ses_core_shell"), order: "asc" })

      expect(messages).toHaveLength(1)
      expect(messages[0]).toMatchObject({
        id: "msg_core_shell",
        type: "shell",
        callID: "call_core_shell",
        command: "pwd",
        output: "/workspace",
      })
      if (messages[0]?.type === "shell") {
        expect(DateTime.toEpochMillis(messages[0].time.created)).toBe(30)
        expect(messages[0].time.completed ? DateTime.toEpochMillis(messages[0].time.completed) : undefined).toBe(40)
      }
    }),
  )

  it.effect("restores compaction events from file-backed session.jsonl", () =>
    Effect.gen(function* () {
      const data = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "atree-core-data-")))
      const root = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "atree-core-root-")))
      const node = path.join(root, "inbox")
      const previousData = Global.Path.data
      ;(Global.Path as { data: string }).data = data
      yield* Effect.addFinalizer(() => Effect.sync(() => ((Global.Path as { data: string }).data = previousData)))

      yield* Effect.promise(() =>
        writeAtreeSession({
          root,
          directory: node,
          sessionID: "ses_core_compaction",
          title: "Core compaction",
          createdAt: 10,
          updatedAt: 20,
        }),
      )
      yield* Effect.promise(() =>
        appendSessionJsonl(node, "ses_core_compaction", [
          {
            type: "session.next.compaction.ended",
            messageID: "msg_core_compaction",
            reason: "auto",
            text: "Summary of older work",
            recent: "Recent turns",
            timestamp: 30,
          },
        ]),
      )

      const sessions = yield* SessionV2.Service
      const messages = yield* sessions.messages({
        sessionID: SessionV2.ID.make("ses_core_compaction"),
        order: "asc",
      })

      expect(messages).toHaveLength(1)
      expect(messages[0]).toMatchObject({
        id: "msg_core_compaction",
        type: "compaction",
        reason: "auto",
        summary: "Summary of older work",
        recent: "Recent turns",
      })
      if (messages[0]?.type === "compaction") {
        expect(DateTime.toEpochMillis(messages[0].time.created)).toBe(30)
      }
    }),
  )

  it.effect("replays removed parts from file-backed session.jsonl", () =>
    Effect.gen(function* () {
      const data = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "atree-core-data-")))
      const root = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "atree-core-root-")))
      const node = path.join(root, "inbox")
      const previousData = Global.Path.data
      ;(Global.Path as { data: string }).data = data
      yield* Effect.addFinalizer(() => Effect.sync(() => ((Global.Path as { data: string }).data = previousData)))

      yield* Effect.promise(() =>
        writeAtreeSession({
          root,
          directory: node,
          sessionID: "ses_core_removed_part",
          title: "Core removed part",
          createdAt: 10,
          updatedAt: 20,
        }),
      )
      yield* Effect.promise(() =>
        appendSessionJsonl(node, "ses_core_removed_part", [
          {
            type: "message.updated",
            message: {
              id: "msg_core_removed_part",
              role: "assistant",
              model: { providerID: "test", modelID: "test", variant: "default" },
              time: { created: 30 },
            },
          },
          {
            type: "message.part.updated",
            part: {
              id: "prt_core_keep",
              messageID: "msg_core_removed_part",
              type: "text",
              text: "keep",
            },
          },
          {
            type: "message.part.updated",
            part: {
              id: "prt_core_remove",
              messageID: "msg_core_removed_part",
              type: "text",
              text: "remove",
            },
          },
          {
            type: "message.part.removed",
            messageID: "msg_core_removed_part",
            partID: "prt_core_remove",
          },
        ]),
      )

      const sessions = yield* SessionV2.Service
      const messages = yield* sessions.messages({
        sessionID: SessionV2.ID.make("ses_core_removed_part"),
        order: "asc",
      })

      expect(messages).toHaveLength(1)
      expect(messages[0]).toMatchObject({
        id: "msg_core_removed_part",
        type: "assistant",
        content: [{ type: "text", text: "keep" }],
      })
    }),
  )

  it.effect("restores user file parts from file-backed session assets", () =>
    Effect.gen(function* () {
      const data = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "atree-core-data-")))
      const root = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "atree-core-root-")))
      const node = path.join(root, "inbox")
      const previousData = Global.Path.data
      ;(Global.Path as { data: string }).data = data
      yield* Effect.addFinalizer(() => Effect.sync(() => ((Global.Path as { data: string }).data = previousData)))

      yield* Effect.promise(() =>
        writeAtreeSession({
          root,
          directory: node,
          sessionID: "ses_core_asset",
          title: "Core asset",
          createdAt: 10,
          updatedAt: 20,
        }),
      )
      yield* Effect.promise(() =>
        mkdir(path.join(node, ".agents", "atree", "sessions", "ses_core_asset", "assets"), { recursive: true }),
      )
      yield* Effect.promise(() =>
        writeFile(
          path.join(node, ".agents", "atree", "sessions", "ses_core_asset", "assets", "hello.txt"),
          "hello asset",
        ),
      )
      yield* Effect.promise(() =>
        appendSessionJsonl(node, "ses_core_asset", [
          {
            type: "message.updated",
            message: {
              id: "msg_core_asset",
              role: "user",
              time: { created: 30 },
            },
          },
          {
            type: "message.part.updated",
            part: {
              id: "prt_core_asset_text",
              messageID: "msg_core_asset",
              type: "text",
              text: "asset attached",
            },
          },
          {
            type: "message.part.updated",
            part: {
              id: "prt_core_asset_file",
              messageID: "msg_core_asset",
              type: "file",
              mime: "text/plain",
              filename: "hello.txt",
              url: "assets/hello.txt",
            },
          },
        ]),
      )

      const sessions = yield* SessionV2.Service
      const messages = yield* sessions.messages({ sessionID: SessionV2.ID.make("ses_core_asset"), order: "asc" })

      expect(messages).toHaveLength(1)
      expect(messages[0]).toMatchObject({
        id: "msg_core_asset",
        type: "user",
        text: "asset attached",
        files: [{ uri: "data:text/plain;base64,aGVsbG8gYXNzZXQ=", mime: "text/plain", name: "hello.txt" }],
      })
    }),
  )
})
