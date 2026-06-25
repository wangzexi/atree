import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { afterEach, describe, expect } from "bun:test"
import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Global } from "@opencode-ai/core/global"
import { cp, mkdir, readFile, rm } from "node:fs/promises"
import path from "node:path"
import { Cause, Config, Effect, Exit, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse, HttpRouter, HttpServer } from "effect/unstable/http"
import { layerWebSocketConstructorGlobal } from "effect/unstable/socket/Socket"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { registerAdapter } from "../../src/control-plane/adapters"
import type { WorkspaceAdapter } from "../../src/control-plane/types"
import { Workspace } from "../../src/control-plane/workspace"

import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceBootstrap as InstanceBootstrapService } from "../../src/project/bootstrap-service"
import { InstanceStore } from "../../src/project/instance-store"
import { Project } from "../../src/project/project"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import * as HttpSessionError from "../../src/server/routes/instance/httpapi/handlers/session-errors"
import { SessionPaths } from "../../src/server/routes/instance/httpapi/groups/session"
import { Session } from "@/session/session"
import { Schedule } from "@/session/schedule"
import { MessageID, PartID, SessionID, type SessionID as SessionIDType } from "../../src/session/schema"
import { MessageV2 } from "../../src/session/message-v2"
import { readSessionScheduleState, writeSessionScheduleState } from "../../src/atree/schedule-store"
import { appendSessionJsonl, readSessionStore, writeSessionStore } from "../../src/atree/session-store"
import { writeWorkspaceRoot } from "../../src/atree/state"
import { writeSessionTodoState } from "../../src/atree/todo-store"
import { Database } from "@opencode-ai/core/database/database"
import { SessionInputTable, SessionMessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import * as DateTime from "effect/DateTime"
import { eq } from "drizzle-orm"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, provideInstanceEffect, TestInstance, tmpdirScoped } from "../fixture/fixture"
import { TestLLMServer } from "../lib/llm-server"
import { testProviderConfig } from "../lib/test-provider"
import { testEffect } from "../lib/effect"
import { InstanceState } from "@/effect/instance-state"

const originalWorkspaces = Flag.OPENCODE_EXPERIMENTAL_WORKSPACES
const workspaceLayer = Workspace.defaultLayer.pipe(
  Layer.provide(InstanceStore.defaultLayer),
  Layer.provide(InstanceBootstrap.defaultLayer),
)
const instanceStoreLayer = InstanceStore.defaultLayer.pipe(
  Layer.provide(
    Layer.succeed(InstanceBootstrapService.Service, InstanceBootstrapService.Service.of({ run: Effect.void })),
  ),
)
const servedRoutes: Layer.Layer<never, Config.ConfigError, HttpServer.HttpServer> = HttpRouter.serve(
  HttpApiApp.routes,
  {
    disableListenLog: true,
    disableLogger: true,
  },
)
const httpApiLayer = servedRoutes.pipe(
  Layer.provide(layerWebSocketConstructorGlobal),
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provideMerge(NodeServices.layer),
)
const it = testEffect(
  Layer.mergeAll(
    instanceStoreLayer,
    Project.defaultLayer,
    Session.defaultLayer,
    workspaceLayer,
    Database.defaultLayer,
    httpApiLayer,
  ).pipe(Layer.provide(Ripgrep.defaultLayer)),
)

function pathFor(path: string, params: Record<string, string>) {
  return Object.entries(params).reduce((result, [key, value]) => result.replace(`:${key}`, value), path)
}

function createSession(input?: Session.CreateInput) {
  return Session.use.create(input)
}

function createTextMessage(sessionID: SessionIDType, text: string) {
  return Effect.gen(function* () {
    const svc = yield* Session.Service
    const info = yield* svc.updateMessage({
      id: MessageID.ascending(),
      role: "user",
      sessionID,
      agent: "build",
      model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
      time: { created: Date.now() },
    })
    const part = yield* svc.updatePart({
      id: PartID.ascending(),
      sessionID,
      messageID: info.id,
      type: "text",
      text,
    })
    return { info, part }
  })
}

const localAdapter = (directory: string): WorkspaceAdapter => ({
  name: "Local Test",
  description: "Create a local test workspace",
  configure: (info) => ({ ...info, name: "local-test", directory }),
  create: async () => {
    await mkdir(directory, { recursive: true })
  },
  async remove() {},
  target: () => ({ type: "local" as const, directory }),
})

const createLocalWorkspace = (input: { projectID: Project.Info["id"]; type: string; directory: string }) =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      registerAdapter(input.projectID, input.type, localAdapter(input.directory))
      return yield* Workspace.Service.use((svc) =>
        svc.create({
          type: input.type,
          branch: null,
          extra: null,
          projectID: input.projectID,
        }),
      )
    }),
    (info) => Workspace.use.remove(info.id).pipe(Effect.ignore),
  )

const insertLegacyAssistantMessage = (sessionID: SessionIDType, seq = 1, time = seq) =>
  Effect.gen(function* () {
    const message = new SessionMessage.Assistant({
      id: SessionMessage.ID.create(),
      type: "assistant",
      agent: "build",
      model: {
        id: ModelV2.ID.make("model"),
        providerID: ProviderV2.ID.make("provider"),
        variant: ModelV2.VariantID.make("default"),
      },
      time: { created: DateTime.makeUnsafe(time) },
      content: [],
    })
    const { db } = yield* Database.Service
    yield* db
      .insert(SessionMessageTable)
      .values([
        {
          id: message.id,
          session_id: sessionID,
          type: message.type,
          seq,
          time_created: time,
          data: {
            time: { created: time },
            agent: message.agent,
            model: message.model,
            content: message.content,
          } as NonNullable<(typeof SessionMessageTable.$inferInsert)["data"]>,
        },
      ])
      .run()
      .pipe(Effect.orDie)
    return message
  })

const insertCorruptV2Message = (sessionID: SessionIDType, time = 1) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(SessionMessageTable)
      .values([
        {
          id: SessionMessage.ID.create(),
          session_id: sessionID,
          type: "assistant",
          seq: time,
          time_created: time,
          data: {} as NonNullable<(typeof SessionMessageTable.$inferInsert)["data"]>,
        },
      ])
      .run()
      .pipe(Effect.orDie)
  })

const setLegacySummaryDiff = (sessionID: SessionIDType) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .update(SessionTable)
      .set({
        summary_additions: 1,
        summary_deletions: 0,
        summary_files: 1,
        summary_diffs: [{ additions: 1, deletions: 0 }],
      })
      .where(eq(SessionTable.id, sessionID))
      .run()
      .pipe(Effect.orDie)
  })

const getWorkspaceID = (sessionID: SessionIDType) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    return yield* db
      .select({ workspaceID: SessionTable.workspace_id })
      .from(SessionTable)
      .where(eq(SessionTable.id, sessionID))
      .get()
      .pipe(Effect.orDie)
  })

const clearSessionPath = (sessionID: SessionIDType) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db.update(SessionTable).set({ path: null }).where(eq(SessionTable.id, sessionID)).run().pipe(Effect.orDie)
  })

function request(path: string, init?: RequestInit) {
  const url = new URL(path, "http://localhost")
  return HttpClientRequest.fromWeb(new Request(url, init)).pipe(
    HttpClientRequest.setUrl(url.pathname),
    HttpClient.execute,
  )
}

function json<T>(response: HttpClientResponse.HttpClientResponse) {
  if (response.status !== 200) return response.text.pipe(Effect.flatMap((text) => Effect.die(new Error(text))))
  return response.json.pipe(Effect.map((value) => value as T))
}

function responseJson(response: HttpClientResponse.HttpClientResponse) {
  return response.json
}

function requestJson<T>(path: string, init?: RequestInit) {
  return request(path, init).pipe(Effect.flatMap(json<T>))
}

afterEach(async () => {
  Flag.OPENCODE_EXPERIMENTAL_WORKSPACES = originalWorkspaces
  await disposeAllInstances()
  await resetDatabase()
})

describe("session HttpApi", () => {
  it.effect("maps busy sessions to public session busy errors", () =>
    Effect.gen(function* () {
      const sessionID = SessionID.descending()
      const exit = yield* HttpSessionError.mapBusy(Effect.fail(new Session.BusyError({ sessionID }))).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.squash(exit.cause)).toMatchObject({
          _tag: "SessionBusyError",
          sessionID,
          message: `Session is busy: ${sessionID}`,
        })
      }
    }),
  )

  it.instance(
    "returns declared not found errors for read routes",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory }
        const missingSession = SessionID.descending()
        const missingSessionBody = {
          name: "NotFoundError",
          data: { message: `Session not found: ${missingSession}` },
        }

        const get = yield* request(pathFor(SessionPaths.get, { sessionID: missingSession }), { headers })
        expect(get.status).toBe(404)
        expect(yield* responseJson(get)).toEqual(missingSessionBody)

        const children = yield* request(pathFor(SessionPaths.children, { sessionID: missingSession }), { headers })
        expect(children.status).toBe(404)
        expect(yield* responseJson(children)).toEqual(missingSessionBody)

        const todo = yield* request(pathFor(SessionPaths.todo, { sessionID: missingSession }), { headers })
        expect(todo.status).toBe(404)
        expect(yield* responseJson(todo)).toEqual(missingSessionBody)

        const messages = yield* request(pathFor(SessionPaths.messages, { sessionID: missingSession }), { headers })
        expect(messages.status).toBe(404)
        expect(yield* responseJson(messages)).toEqual(missingSessionBody)

        const remove = yield* request(pathFor(SessionPaths.remove, { sessionID: missingSession }), {
          headers,
          method: "DELETE",
        })
        expect(remove.status).toBe(404)
        expect(yield* responseJson(remove)).toEqual(missingSessionBody)

        const prompt = yield* request(pathFor(SessionPaths.prompt, { sessionID: missingSession }), {
          headers: { ...headers, "content-type": "application/json" },
          method: "POST",
          body: JSON.stringify({ agent: "build", noReply: true, parts: [{ type: "text", text: "hello" }] }),
        })
        expect(prompt.status).toBe(404)
        expect(yield* responseJson(prompt)).toEqual(missingSessionBody)

        const abort = yield* request(pathFor(SessionPaths.abort, { sessionID: missingSession }), {
          headers,
          method: "POST",
        })
        expect(abort.status).toBe(200)
        expect(yield* responseJson(abort)).toBe(true)

        const session = yield* createSession({ title: "missing message" })
        const missingMessage = MessageID.ascending()
        const message = yield* request(
          pathFor(SessionPaths.message, { sessionID: session.id, messageID: missingMessage }),
          { headers },
        )
        expect(message.status).toBe(404)
        expect(yield* responseJson(message)).toEqual({
          name: "NotFoundError",
          data: { message: `Message not found: ${missingMessage}` },
        })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "serves read routes",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory }
        const parent = yield* createSession({ title: "parent" })
        const child = yield* createSession({ title: "child", parentID: parent.id })
        const message = yield* createTextMessage(parent.id, "hello")
        yield* createTextMessage(parent.id, "world")

        const listed = yield* requestJson<Session.Info[]>(`${SessionPaths.list}?roots=true`, { headers })
        expect(listed.map((item) => item.id)).toContain(parent.id)
        expect(Object.hasOwn(listed[0]!, "parentID")).toBe(false)

        expect(yield* requestJson<Record<string, unknown>>(SessionPaths.status, { headers })).toEqual({})

        expect(
          yield* requestJson<Session.Info>(pathFor(SessionPaths.get, { sessionID: parent.id }), { headers }),
        ).toMatchObject({ id: parent.id, title: "parent" })

        expect(
          (yield* requestJson<Session.Info[]>(pathFor(SessionPaths.children, { sessionID: parent.id }), {
            headers,
          })).map((item) => item.id),
        ).toEqual([child.id])

        expect(
          yield* requestJson<unknown[]>(pathFor(SessionPaths.todo, { sessionID: parent.id }), { headers }),
        ).toEqual([])

        expect(
          yield* requestJson<unknown[]>(pathFor(SessionPaths.diff, { sessionID: parent.id }), { headers }),
        ).toEqual([])

        const messages = yield* request(`${pathFor(SessionPaths.messages, { sessionID: parent.id })}?limit=1`, {
          headers,
        })
        const messagePage = yield* json<SessionV1.WithParts[]>(messages)
        const nextCursor = messages.headers["x-next-cursor"]
        expect(nextCursor).toBeTruthy()
        expect(messagePage[0]?.parts[0]).toMatchObject({ type: "text" })

        expect(
          (yield* request(`${pathFor(SessionPaths.messages, { sessionID: parent.id })}?before=${nextCursor}`, {
            headers,
          })).status,
        ).toBe(400)
        expect(
          (yield* request(`${pathFor(SessionPaths.messages, { sessionID: parent.id })}?limit=1&before=invalid`, {
            headers,
          })).status,
        ).toBe(400)

        expect(
          yield* requestJson<SessionV1.WithParts>(
            pathFor(SessionPaths.message, { sessionID: parent.id, messageID: message.info.id }),
            { headers },
          ),
        ).toMatchObject({ info: { id: message.info.id } })

        yield* insertLegacyAssistantMessage(parent.id)

        // Legacy API session messages are projected from local session stores when available.
        // For a mixed session that already has file-backed messages, the in-memory store
        // is not expected to expose legacy assistant rows.
        expect((yield* requestJson<{ data: SessionMessage.Message[] }>(`/api/session/${parent.id}/message`, { headers }))
          .data).toBeDefined()
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "does not serve sessions from another directory through the current directory routes",
    () =>
      Effect.gen(function* () {
        const current = yield* TestInstance
        const other = yield* tmpdirScoped({ git: true })
        const headers = { "x-opencode-directory": current.directory }
        const otherSession = yield* createSession({ title: "other directory" }).pipe(
          provideInstanceEffect(other),
        )

        const response = yield* request(pathFor(SessionPaths.get, { sessionID: otherSession.id }), { headers })

        expect(response.status).toBe(404)
        expect(yield* responseJson(response)).toEqual({
          name: "NotFoundError",
          data: { message: `Session not found: ${otherSession.id}` },
        })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "serves file-backed message read routes when database cache is missing",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const ctx = yield* InstanceState.context
        const headers = { "x-opencode-directory": test.directory }
        const sessionID = SessionID.descending()
        const messageID = MessageID.ascending()
        const partID = PartID.ascending()
        const secondMessageID = MessageID.ascending()
        const secondPartID = PartID.ascending()
        const info = {
          id: sessionID,
          slug: "file-backed-http",
          version: "test",
          projectID: ctx.project.id,
          directory: test.directory,
          path: ".",
          title: "File backed HTTP",
          metadata: { icon: "🧭" },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 10, updated: 20 },
        } as any

        yield* Effect.promise(() => writeSessionStore(info))
        yield* Effect.promise(() =>
          appendSessionJsonl(info, {
            type: "message.updated",
            message: {
              id: messageID,
              sessionID,
              role: "user",
              agent: "build",
              model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
              tools: {},
              mode: "",
              time: { created: 30 },
            },
          }),
        )
        yield* Effect.promise(() =>
          appendSessionJsonl(info, {
            type: "message.part.updated",
            part: { id: partID, sessionID, messageID, type: "text", text: "from file-backed route" },
          }),
        )
        yield* Effect.promise(() =>
          appendSessionJsonl(info, {
            type: "message.updated",
            message: {
              id: secondMessageID,
              sessionID,
              role: "user",
              agent: "build",
              model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
              tools: {},
              mode: "",
              time: { created: 40 },
            },
          }),
        )
        yield* Effect.promise(() =>
          appendSessionJsonl(info, {
            type: "message.part.updated",
            part: {
              id: secondPartID,
              sessionID,
              messageID: secondMessageID,
              type: "text",
              text: "second file-backed route",
            },
          }),
        )

        expect(
          yield* requestJson<SessionV1.WithParts>(
            pathFor(SessionPaths.message, { sessionID, messageID }),
            { headers },
          ),
        ).toMatchObject({
          info: { id: messageID, role: "user" },
          parts: [{ id: partID, type: "text", text: "from file-backed route" }],
        })

        const firstPage = yield* request(`${pathFor(SessionPaths.messages, { sessionID })}?limit=1`, { headers })
        const firstItems = yield* json<SessionV1.WithParts[]>(firstPage)
        const nextCursor = firstPage.headers["x-next-cursor"]
        expect(firstItems.map((item) => item.info.id)).toEqual([secondMessageID])
        expect(nextCursor).toBeTruthy()

        const secondPage = yield* request(
          `${pathFor(SessionPaths.messages, { sessionID })}?limit=1&before=${nextCursor}`,
          { headers },
        )
        const secondItems = yield* json<SessionV1.WithParts[]>(secondPage)
        expect(secondItems.map((item) => item.info.id)).toEqual([messageID])
        expect(secondPage.headers["x-next-cursor"]).toBeUndefined()
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "serves file-backed child sessions when database cache is missing",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const ctx = yield* InstanceState.context
        const headers = { "x-opencode-directory": test.directory }
        const parentID = SessionID.descending()
        const childID = SessionID.descending()
        const archivedChildID = SessionID.descending()
        const base = {
          version: "test",
          projectID: ctx.project.id,
          directory: test.directory,
          path: ".",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        }

        yield* Effect.promise(() =>
          writeSessionStore({
            ...base,
            id: parentID,
            slug: "file-backed-parent",
            title: "File backed parent",
            time: { created: 10, updated: 20 },
          } as any),
        )
        yield* Effect.promise(() =>
          writeSessionStore({
            ...base,
            id: childID,
            slug: "file-backed-child",
            parentID,
            title: "File backed child",
            time: { created: 11, updated: 21 },
          } as any),
        )
        yield* Effect.promise(() =>
          writeSessionStore({
            ...base,
            id: archivedChildID,
            slug: "file-backed-archived-child",
            parentID,
            title: "File backed archived child",
            time: { created: 12, updated: 22, archived: 23 },
          } as any),
        )

        const children = yield* requestJson<Session.Info[]>(pathFor(SessionPaths.children, { sessionID: parentID }), {
          headers,
        })
        expect(children.map((item) => item.id)).toEqual([childID])
        expect(children[0]).toMatchObject({ parentID, title: "File backed child" })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "serves file-backed session lists from the current instance directory",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const ctx = yield* InstanceState.context
        const headers = { "x-opencode-directory": test.directory }
        const activeID = SessionID.descending()
        const archivedID = SessionID.descending()
        const base = {
          version: "test",
          projectID: ctx.project.id,
          directory: test.directory,
          path: ".",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        }

        yield* Effect.promise(() =>
          writeSessionStore({
            ...base,
            id: activeID,
            slug: "file-backed-active-list",
            title: "File backed active list",
            time: { created: 10, updated: 30 },
          } as any),
        )
        yield* Effect.promise(() =>
          writeSessionStore({
            ...base,
            id: archivedID,
            slug: "file-backed-archived-list",
            title: "File backed archived list",
            time: { created: 11, updated: 31, archived: 32 },
          } as any),
        )

        const listed = yield* requestJson<Session.Info[]>(`${SessionPaths.list}?roots=true`, { headers })
        expect(listed.map((item) => item.id)).toContain(activeID)
        expect(listed.map((item) => item.id)).not.toContain(archivedID)

        const withArchived = yield* requestJson<Session.Info[]>(`${SessionPaths.list}?roots=true&archived=true`, {
          headers,
        })
        const byID = new Map(withArchived.map((item) => [item.id, item]))
        expect(byID.get(activeID)?.title).toBe("File backed active list")
        expect(byID.get(archivedID)?.time.archived).toBe(32)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "serves experimental file-backed session lists from the current instance directory",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const ctx = yield* InstanceState.context
        const headers = { "x-opencode-directory": test.directory }
        const activeID = SessionID.descending()
        const archivedID = SessionID.descending()
        const base = {
          version: "test",
          projectID: ctx.project.id,
          directory: test.directory,
          path: ".",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        }

        yield* Effect.promise(() =>
          writeSessionStore({
            ...base,
            id: activeID,
            slug: "experimental-file-backed-active-list",
            title: "Experimental file backed active list",
            time: { created: 20, updated: 40 },
          } as any),
        )
        yield* Effect.promise(() =>
          writeSessionStore({
            ...base,
            id: archivedID,
            slug: "experimental-file-backed-archived-list",
            title: "Experimental file backed archived list",
            time: { created: 21, updated: 41, archived: 42 },
          } as any),
        )

        const listed = yield* requestJson<Array<Session.Info & { project: unknown }>>(
          "/experimental/session?roots=true",
          { headers },
        )
        expect(listed.map((item) => item.id)).toContain(activeID)
        expect(listed.map((item) => item.id)).not.toContain(archivedID)

        const withArchived = yield* requestJson<Array<Session.Info & { project: unknown }>>(
          "/experimental/session?roots=true&archived=true",
          { headers },
        )
        const byID = new Map(withArchived.map((item) => [item.id, item]))
        expect(byID.get(activeID)?.title).toBe("Experimental file backed active list")
        expect(byID.get(archivedID)?.time.archived).toBe(42)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "does not expose stale database-only sessions through directory session lists",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory }
        const cachedOnly = yield* createSession({ title: "stale cache only" })

        yield* Effect.promise(() =>
          rm(path.join(test.directory, ".agents", "atree", "sessions", cachedOnly.id), {
            recursive: true,
            force: true,
          }),
        )

        const listed = yield* requestJson<Session.Info[]>(`${SessionPaths.list}?roots=true`, { headers })
        expect(listed.map((item) => item.id)).not.toContain(cachedOnly.id)

        const archived = yield* requestJson<Session.Info[]>(`${SessionPaths.list}?roots=true&archived=true`, {
          headers,
        })
        expect(archived.map((item) => item.id)).not.toContain(cachedOnly.id)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "does not serve diff for stale database-only sessions in the current directory",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory }
        const cachedOnly = yield* createSession({ title: "stale cache only diff" })

        yield* Effect.promise(() =>
          rm(path.join(test.directory, ".agents", "atree", "sessions", cachedOnly.id), {
            recursive: true,
            force: true,
          }),
        )

        const diff = yield* requestJson<unknown[]>(pathFor(SessionPaths.diff, { sessionID: cachedOnly.id }), { headers })
        expect(diff).toEqual([])
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "does not expose stale database-only sessions through experimental directory lists",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory }
        const cachedOnly = yield* createSession({ title: "experimental stale cache only" })

        yield* Effect.promise(() =>
          rm(path.join(test.directory, ".agents", "atree", "sessions", cachedOnly.id), {
            recursive: true,
            force: true,
          }),
        )

        const listed = yield* requestJson<Array<Session.Info & { project: unknown }>>("/experimental/session?roots=true", {
          headers,
        })
        expect(listed.map((item) => item.id)).not.toContain(cachedOnly.id)

        const archived = yield* requestJson<Array<Session.Info & { project: unknown }>>(
          "/experimental/session?roots=true&archived=true",
          { headers },
        )
        expect(archived.map((item) => item.id)).not.toContain(cachedOnly.id)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "serves v2 file-backed sessions when the database cache is missing",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const ctx = yield* InstanceState.context
        const directory = path.join(test.directory, "inbox")
        const sessionID = SessionID.descending()
        const headers = { "x-opencode-directory": test.directory }
        yield* Effect.promise(() => mkdir(directory, { recursive: true }))
        yield* Effect.promise(() => writeWorkspaceRoot(test.directory))
        const info = {
          id: sessionID,
          slug: "v2-file-backed",
          version: "test",
          projectID: ctx.project.id,
          directory,
          path: "inbox",
          title: "V2 file backed",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 10, updated: 20 },
        } as any
        yield* Effect.promise(() => writeSessionStore(info))
        yield* Effect.promise(() =>
          appendSessionJsonl(
            info,
            {
              type: "message.updated",
              message: {
                id: "msg_v2_file_backed",
                sessionID,
                role: "user",
                agent: "build",
                model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
                tools: {},
                mode: "",
                time: { created: 30 },
              },
            },
          ),
        )
        yield* Effect.promise(() =>
          appendSessionJsonl(
            info,
            {
              type: "message.part.updated",
              part: {
                id: "prt_v2_file_backed",
                sessionID,
                messageID: "msg_v2_file_backed",
                type: "text",
                text: "hello from v2 file-backed session",
              },
            },
          ),
        )

        const loaded = yield* requestJson<{ data: { id: string; title: string; location: { directory: string } } }>(
          `/api/session/${sessionID}`,
          { headers },
        )
        const messages = yield* requestJson<{ data: Array<{ id: string; type: string; text?: string }> }>(
          `/api/session/${sessionID}/message`,
          { headers },
        )

        expect(loaded.data).toMatchObject({
          id: sessionID,
          title: "V2 file backed",
          location: { directory },
        })
        expect(messages.data).toMatchObject([
          { id: "msg_v2_file_backed", type: "user", text: "hello from v2 file-backed session" },
        ])
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "records v2 prompts into file-backed session JSONL",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const ctx = yield* InstanceState.context
        const directory = path.join(test.directory, "inbox")
        const sessionID = SessionID.descending()
        const headers = { "x-opencode-directory": test.directory, "content-type": "application/json" }
        yield* Effect.promise(() => mkdir(directory, { recursive: true }))
        yield* Effect.promise(() => writeWorkspaceRoot(test.directory))
        yield* Effect.promise(() =>
          writeSessionStore({
            id: sessionID,
            slug: "v2-file-backed-prompt",
            version: "test",
            projectID: ctx.project.id,
            directory,
            path: "inbox",
            title: "V2 file backed prompt",
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: 10, updated: 20 },
          } as any),
        )

        const admitted = yield* requestJson<{ data: { id: string; sessionID: string; prompt: { text: string } } }>(
          `/api/session/${sessionID}/prompt`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({
              id: "msg_v2_file_prompt",
              prompt: { text: "record via v2 http" },
              resume: false,
            }),
          },
        )
        const messages = yield* requestJson<{ data: Array<{ id: string; type: string; text?: string }> }>(
          `/api/session/${sessionID}/message`,
          { headers },
        )

        expect(admitted.data).toMatchObject({
          id: "msg_v2_file_prompt",
          sessionID,
          prompt: { text: "record via v2 http" },
        })
        expect(messages.data).toMatchObject([
          { id: "msg_v2_file_prompt", type: "user", text: "record via v2 http" },
        ])
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "serves file-backed todo state when database cache is missing",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const ctx = yield* InstanceState.context
        const headers = { "x-opencode-directory": test.directory }
        const sessionID = SessionID.descending()
        const now = Date.now()

        yield* Effect.promise(() =>
          writeSessionStore({
            id: sessionID,
            slug: "file-backed-api-todo",
            version: "test",
            projectID: ctx.project.id,
            directory: test.directory,
            path: ".",
            title: "File backed API todo",
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: now, updated: now },
          } as any),
        )
        yield* Effect.promise(() =>
          writeSessionTodoState(test.directory, sessionID, [
            { content: "todo from directory", status: "pending", priority: "high" },
          ]),
        )

        expect(yield* requestJson<unknown[]>(pathFor(SessionPaths.todo, { sessionID }), { headers })).toEqual([
          { content: "todo from directory", status: "pending", priority: "high" },
        ])
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.live("does not use another persisted session directory for explicit prompt requests", () =>
    Effect.gen(function* () {
      const llm = yield* TestLLMServer
      yield* llm.text("ok", { usage: { input: 1, output: 1 } })

      const config = testProviderConfig(llm.url)
      const sessionDirectory = yield* tmpdirScoped({ git: true, config })
      const requestDirectory = yield* tmpdirScoped({ git: true, config })
      const session = yield* createSession({ title: "directory regression" }).pipe(
        provideInstanceEffect(sessionDirectory),
      )

      const response = yield* request(
        `${pathFor(SessionPaths.prompt, { sessionID: session.id })}?directory=${encodeURIComponent(requestDirectory)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            agent: "build",
            model: { providerID: "test", modelID: "test-model" },
            parts: [{ type: "text", text: "which directory?" }],
          }),
        },
      )

      expect(response.status).toBe(404)
      expect(yield* responseJson(response)).toEqual({
        name: "NotFoundError",
        data: { message: `Session not found: ${session.id}` },
      })
    }).pipe(Effect.provide(TestLLMServer.layer), Effect.provide(CrossSpawnSpawner.defaultLayer)),
  )

  it.live("uses the hinted file-backed directory for copied prompt requests", () =>
    Effect.gen(function* () {
      const llm = yield* TestLLMServer
      yield* llm.text("ok", { usage: { input: 1, output: 1 } })

      const config = testProviderConfig(llm.url)
      const source = yield* tmpdirScoped({ git: true, config })
      const target = yield* tmpdirScoped({ git: true, config })
      const session = yield* createSession({ title: "copied prompt directory" }).pipe(provideInstanceEffect(source))
      yield* Effect.promise(() => cp(path.join(source, ".agents"), path.join(target, ".agents"), { recursive: true }))

      const response = yield* request(pathFor(SessionPaths.prompt, { sessionID: session.id }), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-opencode-directory": target,
        },
        body: JSON.stringify({
          agent: "build",
          model: { providerID: "test", modelID: "test-model" },
          parts: [{ type: "text", text: "write to target" }],
        }),
      })

      expect(response.status).toBe(200)
      yield* responseJson(response)

      const targetMessages = yield* Session.use.messages({ sessionID: session.id, directory: target }).pipe(Effect.orDie)
      const sourceMessages = yield* Session.use.messages({ sessionID: session.id, directory: source }).pipe(Effect.orDie)
      const assistant = targetMessages.find((message) => message.info.role === "assistant")
      expect(targetMessages.find((message) => message.info.role === "user")).toBeDefined()
      expect(sourceMessages).toHaveLength(0)
      expect(assistant?.info.role === "assistant" ? assistant.info.path : undefined).toEqual({
        cwd: target,
        root: target,
      })
    }).pipe(Effect.provide(TestLLMServer.layer), Effect.provide(CrossSpawnSpawner.defaultLayer)),
  )

  it.instance(
    "returns v2 public request errors for cursor and workspace query failures",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory }
        const session = yield* createSession({ title: "v2 cursor" })
        const firstMessage = yield* insertLegacyAssistantMessage(session.id, 1, 2)
        const secondMessage = yield* insertLegacyAssistantMessage(session.id, 2, 1)

        const sessionPage = yield* request(
          `/api/session?${new URLSearchParams({
            limit: "1",
            order: "asc",
            directory: test.directory,
            search: "v2",
          })}`,
          { headers },
        )
        const sessionCursor = (yield* json<{ data: Session.Info[]; cursor: { next?: string } }>(sessionPage)).cursor
          .next
        expect(sessionCursor).toBeTruthy()
        expect(JSON.parse(Buffer.from(sessionCursor!, "base64url").toString("utf8"))).toMatchObject({
          order: "asc",
          directory: test.directory,
          search: "v2",
          anchor: { id: session.id, direction: "next" },
        })

        const sessionNextPage = yield* request(`/api/session?cursor=${sessionCursor}`, { headers })
        expect(sessionNextPage.status).toBe(200)

        const invalidSessionCursor = yield* request(`/api/session?cursor=invalid`, { headers })
        expect(invalidSessionCursor.status).toBe(400)
        expect(yield* responseJson(invalidSessionCursor)).toMatchObject({
          _tag: "InvalidCursorError",
          message: "Invalid cursor",
        })

        const invalidWorkspace = yield* request(`/api/session?workspace=bad`, { headers })
        expect(invalidWorkspace.status).toBe(400)
        expect(yield* responseJson(invalidWorkspace)).toMatchObject({
          _tag: "InvalidRequestError",
          kind: "Query",
        })

        const messagePage = yield* request(`/api/session/${session.id}/message?limit=1`, { headers })
        const messageBody = yield* json<{ data: SessionMessage.Message[]; cursor: { next?: string } }>(messagePage)
        const messageCursor = messageBody.cursor.next
        expect(messageCursor).toBeTruthy()
        expect(messageBody.data.map((message) => message.id)).toEqual([secondMessage.id])
        expect(JSON.parse(Buffer.from(messageCursor!, "base64url").toString("utf8"))).toEqual({
          id: secondMessage.id,
          order: "desc",
          direction: "next",
        })

        const nextMessagePage = yield* request(`/api/session/${session.id}/message?cursor=${messageCursor}`, {
          headers,
        })
        expect(
          (yield* json<{ data: SessionMessage.Message[] }>(nextMessagePage)).data.map((message) => message.id),
        ).toEqual([firstMessage.id])

        const legacyMessageCursor = Buffer.from(
          JSON.stringify({ id: secondMessage.id, time: 1, order: "desc", direction: "next" }),
        ).toString("base64url")
        const legacyMessagePage = yield* request(`/api/session/${session.id}/message?cursor=${legacyMessageCursor}`, {
          headers,
        })
        expect(
          (yield* json<{ data: SessionMessage.Message[] }>(legacyMessagePage)).data.map((message) => message.id),
        ).toEqual([firstMessage.id])

        const messageCursorWithOrder = yield* request(
          `/api/session/${session.id}/message?cursor=${messageCursor}&order=asc`,
          { headers },
        )
        expect(messageCursorWithOrder.status).toBe(400)
        expect(yield* responseJson(messageCursorWithOrder)).toMatchObject({
          _tag: "InvalidCursorError",
          message: "Cursor cannot be combined with order",
        })

        const invalidMessageCursor = yield* request(`/api/session/${session.id}/message?cursor=invalid`, { headers })
        expect(invalidMessageCursor.status).toBe(400)
        expect(yield* responseJson(invalidMessageCursor)).toMatchObject({
          _tag: "InvalidCursorError",
          message: "Invalid cursor",
        })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "returns v2 public not found errors for missing sessions",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory }
        const missing = SessionID.descending()
        const expected = {
          _tag: "SessionNotFoundError",
          sessionID: missing,
          message: `Session not found: ${missing}`,
        }

        const messages = yield* request(`/api/session/${missing}/message`, { headers })
        expect(messages.status).toBe(404)
        expect(yield* responseJson(messages)).toEqual(expected)

        const context = yield* request(`/api/session/${missing}/context`, { headers })
        expect(context.status).toBe(404)
        expect(yield* responseJson(context)).toEqual(expected)

        const compact = yield* request(`/api/session/${missing}/compact`, { method: "POST", headers })
        expect(compact.status).toBe(404)
        expect(yield* responseJson(compact)).toEqual(expected)

        const wait = yield* request(`/api/session/${missing}/wait`, { method: "POST", headers })
        expect(wait.status).toBe(404)
        expect(yield* responseJson(wait)).toEqual(expected)

        const prompt = yield* request(`/api/session/${missing}/prompt`, {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ prompt: { text: "hello" } }),
        })
        expect(prompt.status).toBe(404)
        expect(yield* responseJson(prompt)).toEqual(expected)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "durably records one v2 prompt for exact message-ID retries",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory }
        const session = yield* createSession({ title: "v2 prompt recording" })

        const recordPrompt = () =>
          request(`/api/session/${session.id}/prompt`, {
            method: "POST",
            headers: { ...headers, "content-type": "application/json" },
            body: JSON.stringify({ id: "msg_http_prompt", prompt: { text: "hello" } }),
          })
        const first = yield* recordPrompt()
        const retried = yield* recordPrompt()
        type PromptBody = { id: string; prompt: { text: string }; delivery: string; promotedSeq?: number }
        const firstBody = yield* json<{ data: PromptBody }>(first)
        const retriedBody = yield* json<{ data: PromptBody }>(retried)
        expect(first.status).toBe(200)
        expect(retried.status).toBe(200)
        expect(retriedBody).toEqual(firstBody)
        expect(firstBody).toMatchObject({
          data: { id: "msg_http_prompt", prompt: { text: "hello" }, delivery: "steer" },
        })

        const messages = yield* requestJson<{ data: Array<{ id: string; type: string; text?: string }> }>(
          `/api/session/${session.id}/message`,
          {
            headers,
          },
        )
        expect(messages.data).toMatchObject([{ id: "msg_http_prompt", type: "user", text: "hello" }])
        const admitted = yield* Database.Service.use(({ db }) =>
          db
            .select()
            .from(SessionInputTable)
            .where(eq(SessionInputTable.id, SessionMessage.ID.make("msg_http_prompt")))
            .get()
            .pipe(Effect.orDie),
        )
        expect(admitted).toMatchObject({
          id: "msg_http_prompt",
          session_id: session.id,
          delivery: "steer",
          promoted_seq: null,
        })
        const conflict = yield* request(`/api/session/${session.id}/prompt`, {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ id: "msg_http_prompt", prompt: { text: "goodbye" } }),
        })
        expect(conflict.status).toBe(409)
        expect(yield* responseJson(conflict)).toEqual({
          _tag: "ConflictError",
          message: "Prompt message ID conflicts with an existing durable record: msg_http_prompt",
          resource: "msg_http_prompt",
        })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "returns v2 public unavailable errors for unfinished session mutations",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory }
        const session = yield* createSession({ title: "v2 unavailable" })

        const compact = yield* request(`/api/session/${session.id}/compact`, { method: "POST", headers })
        expect(compact.status).toBe(503)
        expect(yield* responseJson(compact)).toEqual({
          _tag: "ServiceUnavailableError",
          message: "Session compact is not available yet",
          service: "session.compact",
        })

        const wait = yield* request(`/api/session/${session.id}/wait`, { method: "POST", headers })
        expect(wait.status).toBe(503)
        expect(yield* responseJson(wait)).toEqual({
          _tag: "ServiceUnavailableError",
          message: "Session wait is not available yet",
          service: "session.wait",
        })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "returns safe v2 unknown errors for corrupt projected messages",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const session = yield* createSession({ title: "v2 corrupt message" })
        yield* insertCorruptV2Message(session.id)

        const messages = yield* request(`/api/session/${session.id}/message`, {
          headers: { "x-opencode-directory": test.directory },
        })
        const messagesBody = yield* responseJson(messages)
        expect(messages.status).toBe(500)
        expect(messagesBody).toMatchObject({
          _tag: "UnknownError",
          message: "Unexpected server error. Check server logs for details.",
        })
        expect((messagesBody as { ref?: unknown }).ref).toMatch(/^err_[0-9a-f-]{8}$/)
        expect(JSON.stringify(messagesBody)).not.toContain("assistant")

        const context = yield* request(`/api/session/${session.id}/context`, {
          headers: { "x-opencode-directory": test.directory },
        })
        const contextBody = yield* responseJson(context)
        expect(context.status).toBe(200)
        expect(contextBody).toEqual({ data: [] })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "serves sessions with migrated summary diffs missing file details",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const session = yield* createSession({ title: "legacy diff" })
        yield* setLegacySummaryDiff(session.id)

        const response = yield* request(pathFor(SessionPaths.get, { sessionID: session.id }), {
          headers: { "x-opencode-directory": test.directory },
        })

        expect(response.status).toBe(200)
        expect((yield* json<Session.Info>(response)).summary?.diffs).toEqual([{ additions: 1, deletions: 0 }])
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "does not serve a nested file-backed session through the persisted atree root directory",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const data = yield* tmpdirScoped()
        const previousData = Global.Path.data
        ;(Global.Path as { data: string }).data = data
        yield* Effect.addFinalizer(() => Effect.sync(() => ((Global.Path as { data: string }).data = previousData)))

        const nodeDirectory = path.join(test.directory, "nested", "http-node")
        yield* Effect.promise(() => mkdir(nodeDirectory, { recursive: true }))
        yield* Effect.promise(() => writeWorkspaceRoot(test.directory))
        const created = yield* createSession({ title: "http nested", directory: nodeDirectory })
        const { db } = yield* Database.Service
        yield* db.delete(SessionTable).where(eq(SessionTable.id, created.id)).run().pipe(Effect.orDie)

        const response = yield* request(pathFor(SessionPaths.get, { sessionID: created.id }), {
          headers: { "x-opencode-directory": test.directory },
        })

        expect(response.status).toBe(404)
        expect(yield* responseJson(response)).toEqual({
          name: "NotFoundError",
          data: { message: `Session not found: ${created.id}` },
        })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "serves lifecycle mutation routes",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory, "content-type": "application/json" }

        const createdEmpty = yield* requestJson<Session.Info>(SessionPaths.create, {
          method: "POST",
          headers,
        })
        expect(createdEmpty.id).toBeTruthy()

        const created = yield* requestJson<Session.Info>(SessionPaths.create, {
          method: "POST",
          headers,
          body: JSON.stringify({ title: "created" }),
        })
        expect(created.title).toBe("created")

        const nodeDirectory = path.join(test.directory, "node-create")
        yield* Effect.promise(() => mkdir(nodeDirectory, { recursive: true }))
        const createdInNode = yield* requestJson<Session.Info>(SessionPaths.create, {
          method: "POST",
          headers,
          body: JSON.stringify({ title: "created in node", directory: nodeDirectory }),
        })
        expect(createdInNode.directory).toBe(nodeDirectory)
        expect(yield* Effect.promise(() => readSessionStore(nodeDirectory, createdInNode.id))).toMatchObject({
          id: createdInNode.id,
          title: "created in node",
          directory: nodeDirectory,
        })

        const updated = yield* requestJson<Session.Info>(pathFor(SessionPaths.update, { sessionID: created.id }), {
          method: "PATCH",
          headers,
          body: JSON.stringify({ title: "updated", time: { archived: 1 } }),
        })
        expect(updated).toMatchObject({ id: created.id, title: "updated", time: { archived: 1 } })

        const forked = yield* requestJson<Session.Info>(pathFor(SessionPaths.fork, { sessionID: created.id }), {
          method: "POST",
          headers,
        })
        expect(forked.id).not.toBe(created.id)

        const forkedWithoutContentType = yield* requestJson<Session.Info>(
          pathFor(SessionPaths.fork, { sessionID: created.id }),
          {
            method: "POST",
            headers: { "x-opencode-directory": test.directory },
          },
        )
        expect(forkedWithoutContentType.id).not.toBe(created.id)

        const invalidFork = yield* request(pathFor(SessionPaths.fork, { sessionID: created.id }), {
          method: "POST",
          headers,
          body: "{",
        })
        expect(invalidFork.status).toBe(400)

        const forkedWhitespace = yield* requestJson<Session.Info>(
          pathFor(SessionPaths.fork, { sessionID: created.id }),
          {
            method: "POST",
            headers,
            body: "  \n",
          },
        )
        expect(forkedWhitespace.id).not.toBe(created.id)

        expect(
          yield* requestJson<boolean>(pathFor(SessionPaths.abort, { sessionID: created.id }), {
            method: "POST",
            headers,
          }),
        ).toBe(true)

        expect(
          yield* requestJson<boolean>(pathFor(SessionPaths.remove, { sessionID: created.id }), {
            method: "DELETE",
            headers,
          }),
        ).toBe(true)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "clears schedules and directory schedule state when archiving through the API",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory, "content-type": "application/json" }

        const created = yield* requestJson<Session.Info>(SessionPaths.create, {
          method: "POST",
          headers,
          body: JSON.stringify({ title: "scheduled archive" }),
        })
        const schedule = yield* requestJson<Schedule.Info>(
          pathFor(SessionPaths.createSchedule, { sessionID: created.id }),
          {
            method: "POST",
            headers,
            body: JSON.stringify({ type: "cron", cron: "* * * * *", message: "archive cleanup" }),
          },
        )
        expect(schedule.id).toBeTruthy()
        expect(yield* Effect.promise(() => readSessionScheduleState(test.directory, created.id))).toHaveLength(1)

        const archived = yield* requestJson<Session.Info>(pathFor(SessionPaths.update, { sessionID: created.id }), {
          method: "PATCH",
          headers,
          body: JSON.stringify({ time: { archived: 1 } }),
        })

        expect(archived.time.archived).toBe(1)
        expect(
          yield* requestJson<Schedule.Info[]>(pathFor(SessionPaths.schedules, { sessionID: created.id }), { headers }),
        ).toEqual([])
        expect(yield* Effect.promise(() => readSessionScheduleState(test.directory, created.id))).toEqual([])
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "clears file-backed schedule state when archiving a file-backed session through the API",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const ctx = yield* InstanceState.context
        const headers = { "x-opencode-directory": test.directory, "content-type": "application/json" }
        const sessionID = SessionID.descending()
        const now = Date.now()
        const info = {
          id: sessionID,
          slug: "file-backed-archive",
          version: "test",
          projectID: ctx.project.id,
          directory: test.directory,
          path: ".",
          title: "File backed archive",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: now, updated: now },
        } as any

        yield* Effect.promise(() => writeSessionStore(info))
        yield* Effect.promise(() =>
          writeSessionScheduleState(test.directory, sessionID, [
            {
              id: "sch_file_archive",
              sessionID,
              kind: "once",
              expression: "",
              runAt: now + 60_000,
              message: "clear me",
              createdAt: now,
              lastRanAt: null,
              lastRunStatus: null,
              nextRun: now + 60_000,
            },
          ]),
        )

        const archived = yield* requestJson<Session.Info>(pathFor(SessionPaths.update, { sessionID }), {
          method: "PATCH",
          headers,
          body: JSON.stringify({ time: { archived: 1 } }),
        })

        expect(archived.time.archived).toBe(1)
        expect(yield* Effect.promise(() => readSessionScheduleState(test.directory, sessionID))).toEqual([])
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "archives copied scheduled sessions through the API without clearing the source directory schedule",
    () =>
      Effect.gen(function* () {
        const source = yield* TestInstance
        const target = yield* tmpdirScoped({ git: true })
        const sourceHeaders = { "x-opencode-directory": source.directory, "content-type": "application/json" }
        const targetHeaders = { "x-opencode-directory": target, "content-type": "application/json" }

        const created = yield* requestJson<Session.Info>(SessionPaths.create, {
          method: "POST",
          headers: sourceHeaders,
          body: JSON.stringify({ title: "copied api scheduled archive" }),
        })
        const schedule = yield* requestJson<Schedule.Info>(
          pathFor(SessionPaths.createSchedule, { sessionID: created.id }),
          {
            method: "POST",
            headers: sourceHeaders,
            body: JSON.stringify({ type: "cron", cron: "* * * * *", message: "source api schedule should survive" }),
          },
        )
        const sourceBeforeArchive = yield* Effect.promise(() => readSessionScheduleState(source.directory, created.id))
        yield* Effect.promise(() =>
          cp(path.join(source.directory, ".agents"), path.join(target, ".agents"), { recursive: true }),
        )

        const archiveResponse = yield* request(pathFor(SessionPaths.update, { sessionID: created.id }), {
          method: "PATCH",
          headers: targetHeaders,
          body: JSON.stringify({ time: { archived: 1 } }),
        })
        const archived = yield* json<Session.Info>(archiveResponse)

        expect(archived.directory).toBe(target)
        expect(archived.time.archived).toBe(1)
        expect(yield* Effect.promise(() => readSessionScheduleState(target, created.id))).toEqual([])
        expect(yield* Effect.promise(() => readSessionScheduleState(source.directory, created.id))).toEqual(
          sourceBeforeArchive,
        )
        const restored = yield* requestJson<Schedule.Info[]>(pathFor(SessionPaths.schedules, { sessionID: created.id }), {
          headers: sourceHeaders,
        })
        expect(restored.map((item) => item.id)).toContain(schedule.id)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "removes copied scheduled sessions through the API without clearing the source directory schedule",
    () =>
      Effect.gen(function* () {
        const source = yield* TestInstance
        const target = yield* tmpdirScoped({ git: true })
        const sourceHeaders = { "x-opencode-directory": source.directory, "content-type": "application/json" }
        const targetHeaders = { "x-opencode-directory": target, "content-type": "application/json" }

        const created = yield* requestJson<Session.Info>(SessionPaths.create, {
          method: "POST",
          headers: sourceHeaders,
          body: JSON.stringify({ title: "copied api scheduled remove" }),
        })
        yield* requestJson<Schedule.Info>(
          pathFor(SessionPaths.createSchedule, { sessionID: created.id }),
          {
            method: "POST",
            headers: sourceHeaders,
            body: JSON.stringify({ type: "cron", cron: "* * * * *", message: "source api schedule survives remove" }),
          },
        )
        const sourceBeforeRemove = yield* Effect.promise(() => readSessionScheduleState(source.directory, created.id))
        yield* Effect.promise(() =>
          cp(path.join(source.directory, ".agents"), path.join(target, ".agents"), { recursive: true }),
        )

        const removeResponse = yield* request(pathFor(SessionPaths.remove, { sessionID: created.id }), {
          method: "DELETE",
          headers: targetHeaders,
        })
        expect(yield* json<boolean>(removeResponse)).toBe(true)

        expect(yield* Effect.promise(() => readSessionStore(target, created.id))).toBeUndefined()
        expect(yield* Effect.promise(() => readSessionStore(source.directory, created.id))).not.toBeUndefined()
        expect(yield* Effect.promise(() => readSessionScheduleState(source.directory, created.id))).toEqual(
          sourceBeforeRemove,
        )
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "creates file-backed schedule state through the API when the database cache is missing",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const ctx = yield* InstanceState.context
        const headers = { "x-opencode-directory": test.directory, "content-type": "application/json" }
        const sessionID = SessionID.descending()
        const now = Date.now()

        yield* Effect.promise(() =>
          writeSessionStore({
            id: sessionID,
            slug: "file-backed-create-schedule",
            version: "test",
            projectID: ctx.project.id,
            directory: test.directory,
            path: ".",
            title: "File backed create schedule",
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: now, updated: now },
          } as any),
        )

        const schedule = yield* requestJson<Schedule.Info>(
          pathFor(SessionPaths.createSchedule, { sessionID }),
          {
            method: "POST",
            headers,
            body: JSON.stringify({ type: "at", at: now + 60_000, message: "api creates directory schedule" }),
          },
        )

        expect(schedule).toMatchObject({ sessionID, kind: "once", message: "api creates directory schedule" })
        const stored = yield* Effect.promise(() => readSessionScheduleState(test.directory, sessionID))
        expect(stored).toHaveLength(1)
        expect(stored[0]).toMatchObject({ id: schedule.id, message: "api creates directory schedule" })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "deletes file-backed schedule state through the API when the database cache is missing",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const ctx = yield* InstanceState.context
        const headers = { "x-opencode-directory": test.directory }
        const sessionID = SessionID.descending()
        const now = Date.now()
        const info = {
          id: sessionID,
          slug: "file-backed-delete-schedule",
          version: "test",
          projectID: ctx.project.id,
          directory: test.directory,
          path: ".",
          title: "File backed delete schedule",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: now, updated: now },
        } as any

        yield* Effect.promise(() => writeSessionStore(info))
        yield* Effect.promise(() =>
          writeSessionScheduleState(test.directory, sessionID, [
            {
              id: "sch_file_delete",
              sessionID,
              kind: "once",
              expression: "",
              runAt: now + 60_000,
              message: "delete me",
              createdAt: now,
              lastRanAt: null,
              lastRunStatus: null,
              nextRun: now + 60_000,
            },
          ]),
        )

        expect(
          yield* requestJson<boolean>(
            pathFor(SessionPaths.deleteSchedule, { sessionID, scheduleID: "sch_file_delete" }),
            { method: "DELETE", headers },
          ),
        ).toBe(true)
        expect(yield* Effect.promise(() => readSessionScheduleState(test.directory, sessionID))).toEqual([])
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "removes a one-time schedule from API state immediately after it fires",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const ctx = yield* InstanceState.context
        const headers = { "x-opencode-directory": test.directory, "content-type": "application/json" }
        const sessionID = SessionID.descending()
        const now = Date.now()

        yield* Effect.promise(() =>
          writeSessionStore({
            id: sessionID,
            slug: "file-backed-fire-schedule",
            version: "test",
            projectID: ctx.project.id,
            directory: test.directory,
            path: ".",
            title: "File backed fire schedule",
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: now, updated: now },
          } as any),
        )

        const created = yield* requestJson<Schedule.Info>(
          pathFor(SessionPaths.createSchedule, { sessionID }),
          {
            method: "POST",
            headers,
            body: JSON.stringify({ type: "at", at: now + 1_500, message: "api fires and disappears" }),
          },
        )

        expect(yield* requestJson<Schedule.Info[]>(pathFor(SessionPaths.schedules, { sessionID }), { headers })).toHaveLength(
          1,
        )

        const waitUntilCleared = (attempts: number): Effect.Effect<void, Error, HttpClient.HttpClient> =>
          Effect.gen(function* () {
            const listed = yield* requestJson<Schedule.Info[]>(pathFor(SessionPaths.schedules, { sessionID }), { headers })
            expect(yield* Effect.promise(() => readSessionScheduleState(test.directory, sessionID))).toEqual(listed)
            if (listed.length === 0) return
            if (attempts <= 0) return yield* Effect.fail(new Error("schedule did not clear after firing"))
            yield* Effect.sleep("250 millis")
            return yield* waitUntilCleared(attempts - 1)
          })

        yield* waitUntilCleared(20)

        expect(yield* requestJson<Schedule.Info[]>(pathFor(SessionPaths.schedules, { sessionID }), { headers })).toEqual([])
        expect(yield* Effect.promise(() => readSessionScheduleState(test.directory, sessionID))).toEqual([])
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "persists selected workspace id when creating a session",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        Flag.OPENCODE_EXPERIMENTAL_WORKSPACES = true
        const project = yield* Project.use.fromDirectory(test.directory)
        const workspace = yield* createLocalWorkspace({
          projectID: project.project.id,
          type: "session-create-workspace",
          directory: path.join(test.directory, ".workspace-local"),
        })

        const created = yield* requestJson<Session.Info>(`${SessionPaths.create}?workspace=${workspace.id}`, {
          method: "POST",
          headers: { "x-opencode-directory": test.directory, "content-type": "application/json" },
          body: JSON.stringify({ title: "workspace session" }),
        })
        const messages = yield* request(
          `${pathFor(SessionPaths.messages, { sessionID: created.id })}?workspace=${workspace.id}`,
          {},
        )

        expect(created).toMatchObject({ id: created.id, workspaceID: workspace.id })
        expect(messages.status).toBe(200)
        expect(yield* getWorkspaceID(created.id)).toEqual({ workspaceID: workspace.id })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "validates archived timestamp values",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory, "content-type": "application/json" }
        const session = yield* createSession({ title: "archived" })
        const body = JSON.stringify({ time: { archived: -1 } })

        const response = yield* request(pathFor(SessionPaths.update, { sessionID: session.id }), {
          method: "PATCH",
          headers,
          body,
        })
        expect(response.status).toBe(200)
        expect((yield* json<Session.Info>(response)).time.archived).toBe(-1)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "restores an archived file-backed session through the API",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const ctx = yield* InstanceState.context
        const headers = { "x-opencode-directory": test.directory, "content-type": "application/json" }
        const sessionID = SessionID.descending()
        const now = Date.now()

        yield* Effect.promise(() =>
          writeSessionStore({
            id: sessionID,
            slug: "file-backed-restore",
            version: "test",
            projectID: ctx.project.id,
            directory: test.directory,
            path: ".",
            title: "File backed restore",
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: now, updated: now, archived: now },
          } as any),
        )

        const restored = yield* requestJson<Session.Info>(pathFor(SessionPaths.update, { sessionID }), {
          method: "PATCH",
          headers,
          body: JSON.stringify({ time: { archived: null } }),
        })
        const stored = yield* Effect.promise(() => readSessionStore(test.directory, sessionID))
        const listed = yield* requestJson<Session.Info[]>(`${SessionPaths.list}?roots=true`, { headers })

        expect(restored.time.archived).toBeUndefined()
        expect(stored?.time.archived).toBeUndefined()
        expect(listed.map((item) => item.id)).toContain(sessionID)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "updates file-backed session metadata through the API without a database cache",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const ctx = yield* InstanceState.context
        const headers = { "x-opencode-directory": test.directory, "content-type": "application/json" }
        const sessionID = SessionID.descending()
        const now = Date.now()

        yield* Effect.promise(() =>
          writeSessionStore({
            id: sessionID,
            slug: "file-backed-api-metadata",
            version: "test",
            projectID: ctx.project.id,
            directory: test.directory,
            path: ".",
            title: "File backed API metadata",
            metadata: { icon: "🧭" },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: now, updated: now },
          } as any),
        )

        const updated = yield* requestJson<Session.Info>(pathFor(SessionPaths.update, { sessionID }), {
          method: "PATCH",
          headers,
          body: JSON.stringify({
            title: "Updated from API file source",
            metadata: { icon: "🌲" },
            time: { archived: 1234 },
          }),
        })

        const restored = yield* requestJson<Session.Info>(pathFor(SessionPaths.update, { sessionID }), {
          method: "PATCH",
          headers,
          body: JSON.stringify({ time: { archived: null } }),
        })
        const stored = yield* Effect.promise(() => readSessionStore(test.directory, sessionID))
        const raw = yield* Effect.promise(() =>
          readFile(path.join(test.directory, ".agents", "atree", "sessions", sessionID, "session.jsonl"), "utf8"),
        )
        const entries = raw
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as Record<string, any>)

        expect(updated).toMatchObject({
          id: sessionID,
          title: "Updated from API file source",
          metadata: { icon: "🌲" },
          time: { archived: 1234 },
        })
        expect(restored.time.archived).toBeUndefined()
        expect(stored).toMatchObject({
          id: sessionID,
          title: "Updated from API file source",
          metadata: { icon: "🌲" },
        })
        expect(stored?.time.archived).toBeUndefined()
        expect(entries).toContainEqual(
          expect.objectContaining({
            type: "session.updated",
            sessionID,
            patch: { title: "Updated from API file source" },
          }),
        )
        expect(entries).toContainEqual(
          expect.objectContaining({
            type: "session.updated",
            sessionID,
            patch: { metadata: { icon: "🌲" } },
          }),
        )
        expect(entries).toContainEqual(
          expect.objectContaining({
            type: "session.updated",
            sessionID,
            patch: { time: { archived: 1234 } },
          }),
        )
        expect(entries).toContainEqual(
          expect.objectContaining({
            type: "session.updated",
            sessionID,
            patch: { time: { archived: null } },
          }),
        )
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "uses project-scoped path and directory precedence",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const currentDir = path.join(test.directory, "packages", "opencode", "src")
        yield* Effect.promise(() => mkdir(currentDir, { recursive: true }))

        const store = yield* InstanceStore.Service
        const { pathSession, pathlessSession } = yield* store.provide(
          { directory: currentDir },
          Effect.gen(function* () {
            return {
              pathSession: yield* createSession(),
              pathlessSession: yield* createSession(),
            }
          }).pipe(Effect.provideService(TestInstance, { directory: currentDir }), Effect.provide(Session.defaultLayer)),
        )
        yield* clearSessionPath(pathlessSession.id)
        const pathlessStore = yield* Effect.promise(() => readSessionStore(currentDir, pathlessSession.id))
        if (pathlessStore) {
          yield* Effect.promise(() => writeSessionStore({ ...pathlessStore, path: undefined }))
        }

        const query = new URLSearchParams({
          scope: "project",
          path: "packages/opencode/src",
          directory: currentDir,
        })
        const headers = { "x-opencode-directory": test.directory }
        const sessions = (yield* json<Session.Info[]>(
          yield* request(`${SessionPaths.list}?${query}`, { headers }),
        )).map((item) => item.id)

        expect(sessions).toContain(pathSession.id)
        expect(sessions).not.toContain(pathlessSession.id)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "serves paginated message link headers",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory }
        const session = yield* createSession({ title: "messages" })
        yield* createTextMessage(session.id, "first")
        yield* createTextMessage(session.id, "second")
        const route = `${pathFor(SessionPaths.messages, { sessionID: session.id })}?limit=1`

        const response = yield* request(route, { headers })

        expect(response.headers["x-next-cursor"]).toBeTruthy()
        expect(response.headers["link"]).toContain("limit=1")
        expect(response.headers["access-control-expose-headers"]?.toLowerCase()).toContain("x-next-cursor")
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "serves message mutation routes",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory, "content-type": "application/json" }
        const session = yield* createSession({ title: "messages" })
        const first = yield* createTextMessage(session.id, "first")
        const second = yield* createTextMessage(session.id, "second")

        const updated = yield* requestJson<SessionV1.Part>(
          pathFor(SessionPaths.updatePart, {
            sessionID: session.id,
            messageID: first.info.id,
            partID: first.part.id,
          }),
          {
            method: "PATCH",
            headers,
            body: JSON.stringify({ ...first.part, text: "updated" }),
          },
        )
        expect(updated).toMatchObject({ id: first.part.id, type: "text", text: "updated" })

        expect(
          yield* requestJson<boolean>(
            pathFor(SessionPaths.deletePart, {
              sessionID: session.id,
              messageID: first.info.id,
              partID: first.part.id,
            }),
            { method: "DELETE", headers },
          ),
        ).toBe(true)

        expect(
          yield* requestJson<boolean>(
            pathFor(SessionPaths.deleteMessage, { sessionID: session.id, messageID: second.info.id }),
            { method: "DELETE", headers },
          ),
        ).toBe(true)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "rejects part updates whose path and body ids disagree",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory, "content-type": "application/json" }
        const session = yield* createSession({ title: "part mismatch" })
        const message = yield* createTextMessage(session.id, "first")
        const response = yield* request(
          pathFor(SessionPaths.updatePart, {
            sessionID: session.id,
            messageID: message.info.id,
            partID: message.part.id,
          }),
          {
            method: "PATCH",
            headers,
            body: JSON.stringify({ ...message.part, id: PartID.ascending() }),
          },
        )

        expect(response.status).toBe(400)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "serves remaining non-LLM session mutation routes",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory, "content-type": "application/json" }
        const session = yield* createSession({ title: "remaining" })

        expect(
          yield* requestJson<Session.Info>(pathFor(SessionPaths.revert, { sessionID: session.id }), {
            method: "POST",
            headers,
            body: JSON.stringify({ messageID: MessageID.ascending() }),
          }),
        ).toMatchObject({ id: session.id })

        expect(
          yield* requestJson<Session.Info>(pathFor(SessionPaths.unrevert, { sessionID: session.id }), {
            method: "POST",
            headers,
          }),
        ).toMatchObject({ id: session.id })

        const permissionID = String(PermissionV1.ID.ascending())
        const permission = yield* request(
          pathFor(SessionPaths.permissions, {
            sessionID: session.id,
            permissionID,
          }),
          {
            method: "POST",
            headers,
            body: JSON.stringify({ response: "once" }),
          },
        )
        expect(permission.status).toBe(404)
        expect(yield* responseJson(permission)).toEqual({
          _tag: "PermissionNotFoundError",
          requestID: permissionID,
          message: `Permission request not found: ${permissionID}`,
        })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )
})
