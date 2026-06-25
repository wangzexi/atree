/**
 * Integration test: full session.jsonl chain
 *
 * Verifies that a complete prompt round-trip writes to session.jsonl on disk
 * and that the HTTP messages endpoint reads back from the same file.
 *
 * Chain: HTTP prompt → LLM response → JSONL written → HTTP GET messages
 */
import { afterEach, expect } from "bun:test"
import { NodeServices } from "@effect/platform-node"
import { NodeHttpServer } from "@effect/platform-node"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { Effect, Layer } from "effect"
import { HttpClientResponse, HttpRouter, HttpServer } from "effect/unstable/http"
import { layerWebSocketConstructorGlobal } from "effect/unstable/socket/Socket"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { SessionPaths } from "../../src/server/routes/instance/httpapi/groups/session"
import { Session } from "@/session/session"
import { Project } from "../../src/project/project"
import { InstanceStore } from "../../src/project/instance-store"
import { InstanceBootstrap } from "../../src/project/bootstrap-service"
import { disposeAllInstances, provideInstanceEffect, TestInstance, tmpdirScoped } from "../fixture/fixture"
import { TestLLMServer } from "../lib/llm-server"
import { testProviderConfig } from "../lib/test-provider"
import { testEffect } from "../lib/effect"
import { resetDatabase } from "../fixture/db"
import { request } from "./httpapi-layer"

const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const instanceStoreLayer = InstanceStore.defaultLayer.pipe(Layer.provide(noopBootstrap))

const servedRoutes: Layer.Layer<never, unknown, HttpServer.HttpServer> = HttpRouter.serve(HttpApiApp.routes, {
  disableListenLog: true,
  disableLogger: true,
})

const httpApiLayer = servedRoutes.pipe(
  Layer.provide(layerWebSocketConstructorGlobal),
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provideMerge(NodeServices.layer),
)

const it = testEffect(
  Layer.mergeAll(instanceStoreLayer, Project.defaultLayer, Session.defaultLayer, Database.defaultLayer, httpApiLayer).pipe(
    Layer.provide(Ripgrep.defaultLayer),
  ),
)

function pathFor(template: string, params: Record<string, string>) {
  return Object.entries(params).reduce((result, [key, value]) => result.replace(`:${key}`, value), template)
}

function json<T>(response: HttpClientResponse.HttpClientResponse) {
  return response.json.pipe(Effect.map((value) => value as T))
}

function requestJson<T>(p: string, init?: RequestInit) {
  return request(p, init).pipe(Effect.flatMap(json<T>))
}

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

it.live(
  "writes user and assistant messages to session.jsonl and reads them back via HTTP",
  () =>
    Effect.gen(function* () {
      const llm = yield* TestLLMServer
      yield* llm.text("hello from assistant", { usage: { input: 5, output: 5 } })

      const config = testProviderConfig(llm.url)
      const directory = yield* tmpdirScoped({ git: true, config })
      const headers = { "x-opencode-directory": directory, "content-type": "application/json" }

      const session = yield* Session.use.create({ title: "jsonl chain test" }).pipe(provideInstanceEffect(directory))

      const promptResponse = yield* request(pathFor(SessionPaths.prompt, { sessionID: session.id }), {
        method: "POST",
        headers,
        body: JSON.stringify({
          agent: "build",
          model: { providerID: "test", modelID: "test-model" },
          parts: [{ type: "text", text: "say hello" }],
        }),
      })
      expect(promptResponse.status).toBe(200)

      // Wait for the LLM to be called (confirms the runner executed)
      yield* llm.wait(1)

      // Give the event bridge time to flush the JSONL write
      yield* Effect.sleep("300 millis")

      // Verify session.jsonl exists and contains user + assistant events
      const jsonlPath = path.join(directory, ".agents", "atree", "sessions", session.id, "session.jsonl")
      const raw = yield* Effect.promise(() => readFile(jsonlPath, "utf-8"))
      const types = raw
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => (JSON.parse(line) as { type: string }).type)

      expect(types.some((t) => t === "session.next.prompted" || t === "session.next.prompt.admitted")).toBe(true)
      expect(types.some((t) => t === "session.next.text.started" || t === "session.next.text.ended")).toBe(true)

      // Read back via HTTP messages endpoint — /session/:id/message returns array directly
      const messages = yield* requestJson<SessionV1.WithParts[]>(
        pathFor(SessionPaths.messages, { sessionID: session.id }),
        { headers },
      )

      expect(messages.some((m) => m.info.role === "user")).toBe(true)
      expect(messages.some((m) => m.info.role === "assistant")).toBe(true)
    }).pipe(Effect.provide(TestLLMServer.layer), Effect.provide(CrossSpawnSpawner.defaultLayer)),
)

it.live(
  "session.jsonl is the sole read source when SQLite cache is absent",
  () =>
    Effect.gen(function* () {
      const llm = yield* TestLLMServer
      yield* llm.text("response without cache", { usage: { input: 1, output: 1 } })

      const config = testProviderConfig(llm.url)
      const directory = yield* tmpdirScoped({ git: true, config })
      const headers = { "x-opencode-directory": directory, "content-type": "application/json" }

      const session = yield* Session.use.create({ title: "no-cache jsonl" }).pipe(provideInstanceEffect(directory))

      yield* request(pathFor(SessionPaths.prompt, { sessionID: session.id }), {
        method: "POST",
        headers,
        body: JSON.stringify({
          agent: "build",
          model: { providerID: "test", modelID: "test-model" },
          parts: [{ type: "text", text: "respond" }],
        }),
      })

      yield* llm.wait(1)
      yield* Effect.sleep("300 millis")

      // Wipe SQLite — messages must still come from JSONL
      yield* Effect.promise(resetDatabase)

      const messages = yield* requestJson<SessionV1.WithParts[]>(
        pathFor(SessionPaths.messages, { sessionID: session.id }),
        { headers },
      )

      expect(messages.some((m) => m.info.role === "user")).toBe(true)
      expect(messages.some((m) => m.info.role === "assistant")).toBe(true)
    }).pipe(Effect.provide(TestLLMServer.layer), Effect.provide(CrossSpawnSpawner.defaultLayer)),
)

it.instance(
  "archived session loads from directory files without SQLite",
  () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const headers = { "x-opencode-directory": test.directory }

      // Create and archive a session
      const session = yield* Session.use.create({ title: "will be archived" })
      yield* request(pathFor(SessionPaths.update, { sessionID: session.id }), {
        method: "PATCH",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ time: { archived: Date.now() } }),
      })

      // Wipe SQLite — archived list must still work from meta.yaml
      yield* Effect.promise(resetDatabase)

      const archivedList = yield* requestJson<Array<{ id: string; time: { archived?: number } }>>(
        `${SessionPaths.list}?archived=true`,
        { headers },
      )

      const found = archivedList.find((s) => s.id === session.id)
      expect(found).toBeDefined()
      expect(found?.time.archived).toBeDefined()
    }),
  { git: true, config: { formatter: false, lsp: false } },
)
