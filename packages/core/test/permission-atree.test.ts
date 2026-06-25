import { describe, expect } from "bun:test"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { Global } from "@opencode-ai/core/global"
import { Location } from "@opencode-ai/core/location"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { PermissionSaved } from "@opencode-ai/core/permission/saved"
import { Project } from "@opencode-ai/core/project"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionStore } from "@opencode-ai/core/session/store"
import { Context, Effect, Exit, Layer, Scope } from "effect"
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises"
import os from "os"
import path from "path"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"

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
const permissions = PermissionV2.locationLayer.pipe(
  Layer.provideMerge(database),
  Layer.provideMerge(store),
  Layer.provideMerge(events),
  Layer.provideMerge(current),
  Layer.provideMerge(sessions),
  Layer.provideMerge(SessionExecution.noopLayer),
  Layer.provideMerge(saved),
)
const it = testEffect(permissions)

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

async function writeAtreeSession(input: {
  data: string
  root: string
  directory: string
  sessionID: string
  title: string
  updatedAt?: number
}) {
  await mkdir(path.join(input.data, "atree"), { recursive: true })
  await writeFile(
    path.join(input.data, "atree", "state.json"),
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
      `createdAt: 10`,
      `updatedAt: ${input.updatedAt ?? 20}`,
      `archivedAt: null`,
      `cost: 0`,
      `tokens: {"input":0,"output":0,"reasoning":0,"cache":{"read":0,"write":0}}`,
      `metadata: {}`,
      "",
    ].join("\n"),
  )
}

async function writeSessionJsonl(directory: string, sessionID: string, entries: Record<string, unknown>[]) {
  await writeFile(
    path.join(directory, ".agents", "atree", "sessions", sessionID, "session.jsonl"),
    entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
  )
}

describe("PermissionV2 atree state", () => {
  it.effect("creates permission asks in a directory-backed session without a global session row", () =>
    Effect.gen(function* () {
      const data = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "atree-core-permission-data-"))),
        (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "atree-core-permission-root-"))),
        (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      const node = path.join(root, "inbox")
      const previousData = Global.Path.data
      ;(Global.Path as { data: string }).data = data
      yield* Effect.addFinalizer(() => Effect.sync(() => ((Global.Path as { data: string }).data = previousData)))
      yield* setRules([])

      const sessionID = SessionV2.ID.make("ses_core_permission_directory_ask")
      const permissionID = PermissionV2.ID.create("per_core_permission_directory_ask")

      yield* Effect.promise(() =>
        writeAtreeSession({
          data,
          root,
          directory: node,
          sessionID,
          title: "Core permission directory ask",
        }),
      )

      const service = yield* PermissionV2.Service
      expect(
        yield* service.ask({
          id: permissionID,
          sessionID,
          directory: node,
          agent: AgentV2.ID.make("test"),
          action: "bash",
          resources: ["echo directory"],
          save: ["echo directory"],
        }),
      ).toEqual({ id: permissionID, effect: "ask" })

      const raw = yield* Effect.promise(() =>
        readFile(path.join(node, ".agents", "atree", "sessions", sessionID, "session.jsonl"), "utf8"),
      )
      const entries = raw
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>)
      expect(entries).toContainEqual(
        expect.objectContaining({
          type: "permission.v2.asked",
          id: permissionID,
          sessionID,
          action: "bash",
          resources: ["echo directory"],
        }),
      )
    }),
  )

  it.effect("restores pending permissions from directory session.jsonl and appends replies", () =>
    Effect.gen(function* () {
      const data = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "atree-core-permission-data-"))),
        (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "atree-core-permission-root-"))),
        (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      const node = path.join(root, "inbox")
      const previousData = Global.Path.data
      ;(Global.Path as { data: string }).data = data
      yield* Effect.addFinalizer(() => Effect.sync(() => ((Global.Path as { data: string }).data = previousData)))

      const sessionID = SessionV2.ID.make("ses_core_permission_restore")
      const pendingID = PermissionV2.ID.create("per_core_permission_pending")
      const answeredID = PermissionV2.ID.create("per_core_permission_answered")

      yield* Effect.promise(() =>
        writeAtreeSession({
          data,
          root,
          directory: node,
          sessionID,
          title: "Core permission restore",
        }),
      )
      yield* Effect.promise(() =>
        writeSessionJsonl(node, sessionID, [
          {
            type: "permission.v2.asked",
            id: pendingID,
            sessionID,
            action: "bash",
            resources: ["echo pending"],
            save: ["echo pending"],
            metadata: {},
          },
          {
            type: "permission.v2.asked",
            id: answeredID,
            sessionID,
            action: "bash",
            resources: ["echo answered"],
            save: ["echo answered"],
            metadata: {},
          },
          {
            type: "permission.v2.replied",
            sessionID,
            requestID: answeredID,
            reply: "once",
          },
        ]),
      )

      const service = yield* PermissionV2.Service
      const restored = yield* service.list()
      expect(restored.map((item) => item.id)).toEqual([pendingID])
      expect(restored[0]?.sessionID).toBe(sessionID)
      expect(yield* service.forSession(sessionID)).toHaveLength(1)
      expect(yield* service.get(pendingID)).toMatchObject({ id: pendingID, action: "bash" })

      yield* service.reply({ requestID: pendingID, reply: "once" })
      expect(yield* service.list()).toEqual([])

      const raw = yield* Effect.promise(() =>
        readFile(path.join(node, ".agents", "atree", "sessions", sessionID, "session.jsonl"), "utf8"),
      )
      const entries = raw
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>)
      expect(entries).toContainEqual(
        expect.objectContaining({
          type: "permission.v2.replied",
          sessionID,
          requestID: pendingID,
          reply: "once",
        }),
      )
    }),
  )

  it.effect("removes restored permissions when session.jsonl is answered externally", () =>
    Effect.gen(function* () {
      const data = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "atree-core-permission-data-"))),
        (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "atree-core-permission-root-"))),
        (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      const node = path.join(root, "inbox")
      const previousData = Global.Path.data
      ;(Global.Path as { data: string }).data = data
      yield* Effect.addFinalizer(() => Effect.sync(() => ((Global.Path as { data: string }).data = previousData)))

      const sessionID = SessionV2.ID.make("ses_core_permission_external_reply")
      const pendingID = PermissionV2.ID.create("per_core_permission_external")

      yield* Effect.promise(() =>
        writeAtreeSession({
          data,
          root,
          directory: node,
          sessionID,
          title: "Core permission external reply",
        }),
      )
      yield* Effect.promise(() =>
        writeSessionJsonl(node, sessionID, [
          {
            type: "permission.v2.asked",
            id: pendingID,
            sessionID,
            action: "bash",
            resources: ["echo pending"],
            save: ["echo pending"],
            metadata: {},
          },
        ]),
      )

      const service = yield* PermissionV2.Service
      expect((yield* service.list()).map((item) => item.id)).toEqual([pendingID])

      yield* Effect.promise(() =>
        appendFile(
          path.join(node, ".agents", "atree", "sessions", sessionID, "session.jsonl"),
          JSON.stringify({
            type: "permission.v2.replied",
            sessionID,
            requestID: pendingID,
            reply: "once",
          }) + "\n",
        ),
      )

      expect(yield* service.list()).toEqual([])
      expect(yield* service.get(pendingID)).toBeUndefined()
      expect(yield* service.forSession(sessionID)).toEqual([])
    }),
  )

  it.effect("replies to restored permissions in their source directory when session ids overlap", () =>
    Effect.gen(function* () {
      const data = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "atree-core-permission-data-"))),
        (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "atree-core-permission-root-"))),
        (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      const source = path.join(root, "source")
      const target = path.join(root, "target")
      const previousData = Global.Path.data
      ;(Global.Path as { data: string }).data = data
      yield* Effect.addFinalizer(() => Effect.sync(() => ((Global.Path as { data: string }).data = previousData)))

      const sessionID = SessionV2.ID.make("ses_core_permission_overlap")
      const pendingID = PermissionV2.ID.create("per_core_permission_overlap")

      yield* Effect.promise(() =>
        writeAtreeSession({
          data,
          root,
          directory: source,
          sessionID,
          title: "Permission source",
          updatedAt: 200,
        }),
      )
      yield* Effect.promise(() =>
        writeSessionJsonl(source, sessionID, [
          {
            type: "session.updated",
            sessionID,
            title: "newer unrelated source",
          },
        ]),
      )
      yield* Effect.promise(() =>
        writeAtreeSession({
          data,
          root,
          directory: target,
          sessionID,
          title: "Permission target",
          updatedAt: 100,
        }),
      )
      yield* Effect.promise(() =>
        writeSessionJsonl(target, sessionID, [
          {
            type: "permission.v2.asked",
            id: pendingID,
            sessionID,
            action: "bash",
            resources: ["echo target"],
            save: ["echo target"],
            metadata: {},
          },
        ]),
      )

      const service = yield* PermissionV2.Service
      expect((yield* service.list()).map((item) => item.id)).toEqual([pendingID])
      yield* service.reply({ requestID: pendingID, reply: "once" })

      const sourceRaw = yield* Effect.promise(() =>
        readFile(path.join(source, ".agents", "atree", "sessions", sessionID, "session.jsonl"), "utf8"),
      )
      const targetRaw = yield* Effect.promise(() =>
        readFile(path.join(target, ".agents", "atree", "sessions", sessionID, "session.jsonl"), "utf8"),
      )
      expect(sourceRaw).not.toContain("permission.v2.replied")
      expect(targetRaw).toContain("permission.v2.replied")
      expect(targetRaw).toContain(pendingID)
    }),
  )

  it.effect("does not borrow another copied session when an explicit permission directory is missing", () =>
    Effect.gen(function* () {
      const data = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "atree-core-permission-data-"))),
        (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "atree-core-permission-root-"))),
        (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      const source = path.join(root, "source")
      const target = path.join(root, "target")
      const previousData = Global.Path.data
      ;(Global.Path as { data: string }).data = data
      yield* Effect.addFinalizer(() => Effect.sync(() => ((Global.Path as { data: string }).data = previousData)))
      yield* setRules([])

      const sessionID = SessionV2.ID.make("ses_core_permission_missing_explicit")

      yield* Effect.promise(() =>
        writeAtreeSession({
          data,
          root,
          directory: target,
          sessionID,
          title: "Permission target",
        }),
      )

      const service = yield* PermissionV2.Service
      const error = yield* Effect.flip(
        service.ask({
          sessionID,
          directory: source,
          action: "bash",
          resources: ["echo missing explicit"],
          save: ["echo missing explicit"],
        }),
      )
      expect(error).toBeInstanceOf(SessionV2.NotFoundError)

      const targetRaw = yield* Effect.promise(() =>
        readFile(path.join(target, ".agents", "atree", "sessions", sessionID, "session.jsonl"), "utf8").catch(
          () => "",
        ),
      )
      expect(targetRaw).not.toContain("permission.v2.asked")
      expect(yield* service.list()).toEqual([])
    }),
  )

  it.effect("rejecting one restored permission records sibling rejections in session.jsonl", () =>
    Effect.gen(function* () {
      const data = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "atree-core-permission-data-"))),
        (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "atree-core-permission-root-"))),
        (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      const node = path.join(root, "inbox")
      const previousData = Global.Path.data
      ;(Global.Path as { data: string }).data = data
      yield* Effect.addFinalizer(() => Effect.sync(() => ((Global.Path as { data: string }).data = previousData)))

      const sessionID = SessionV2.ID.make("ses_core_permission_reject_siblings")
      const firstID = PermissionV2.ID.create("per_core_permission_reject_first")
      const secondID = PermissionV2.ID.create("per_core_permission_reject_second")

      yield* Effect.promise(() =>
        writeAtreeSession({
          data,
          root,
          directory: node,
          sessionID,
          title: "Core permission reject siblings",
        }),
      )
      yield* Effect.promise(() =>
        writeSessionJsonl(node, sessionID, [
          {
            type: "permission.v2.asked",
            id: firstID,
            sessionID,
            action: "bash",
            resources: ["echo first"],
            save: ["echo first"],
            metadata: {},
          },
          {
            type: "permission.v2.asked",
            id: secondID,
            sessionID,
            action: "bash",
            resources: ["echo second"],
            save: ["echo second"],
            metadata: {},
          },
        ]),
      )

      const service = yield* PermissionV2.Service
      expect((yield* service.list()).map((item) => item.id)).toEqual([firstID, secondID])
      yield* Effect.exit(service.reply({ requestID: firstID, reply: "reject" }))
      expect(yield* service.list()).toEqual([])

      const raw = yield* Effect.promise(() =>
        readFile(path.join(node, ".agents", "atree", "sessions", sessionID, "session.jsonl"), "utf8"),
      )
      const entries = raw
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>)
      expect(entries).toContainEqual(
        expect.objectContaining({
          type: "permission.v2.replied",
          sessionID,
          requestID: firstID,
          reply: "reject",
        }),
      )
      expect(entries).toContainEqual(
        expect.objectContaining({
          type: "permission.v2.replied",
          sessionID,
          requestID: secondID,
          reply: "reject",
        }),
      )
    }),
  )

  it.effect("does not reject restored pending permissions when the service scope closes", () =>
    Effect.gen(function* () {
      const data = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "atree-core-permission-data-"))),
        (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "atree-core-permission-root-"))),
        (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      const node = path.join(root, "inbox")
      const previousData = Global.Path.data
      ;(Global.Path as { data: string }).data = data
      yield* Effect.addFinalizer(() => Effect.sync(() => ((Global.Path as { data: string }).data = previousData)))

      const sessionID = SessionV2.ID.make("ses_core_permission_scope_close")
      const pendingID = PermissionV2.ID.create("per_core_permission_scope_close")

      yield* Effect.promise(() =>
        writeAtreeSession({
          data,
          root,
          directory: node,
          sessionID,
          title: "Core permission scope close",
        }),
      )
      yield* Effect.promise(() =>
        writeSessionJsonl(node, sessionID, [
          {
            type: "permission.v2.asked",
            id: pendingID,
            sessionID,
            action: "bash",
            resources: ["echo pending"],
            save: ["echo pending"],
            metadata: {},
          },
        ]),
      )

      const scope = yield* Scope.make()
      const service = Context.get(yield* Layer.buildWithScope(Layer.fresh(permissions), scope), PermissionV2.Service)
      expect((yield* service.list()).map((item) => item.id)).toEqual([pendingID])
      yield* Scope.close(scope, Exit.void)

      const raw = yield* Effect.promise(() =>
        readFile(path.join(node, ".agents", "atree", "sessions", sessionID, "session.jsonl"), "utf8"),
      )
      const entries = raw
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>)
      expect(
        entries.some(
          (entry) =>
            entry.type === "permission.v2.replied" && entry.requestID === pendingID && entry.reply === "reject",
        ),
      ).toBe(false)
    }),
  )
})
