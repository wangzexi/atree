import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import fs from "fs/promises"
import path from "path"
import { Session } from "@/session/session"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionCompaction } from "../../src/session/compaction"
import { Schedule } from "../../src/session/schedule"
import { SessionSummary } from "../../src/session/summary"
import { Database } from "@opencode-ai/core/database/database"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { readSessionStore } from "@/atree/session-store"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Command } from "@/command"
import { provideTmpdirServer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"
import { LSP } from "@/lsp/lsp"
import { MCP } from "../../src/mcp"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { RuntimeFlags } from "@/effect/runtime-flags"

const mcp = Layer.succeed(
  MCP.Service,
  MCP.Service.of({
    status: () => Effect.succeed({}),
    clients: () => Effect.succeed({}),
    tools: () => Effect.succeed({}),
    prompts: () => Effect.succeed({}),
    resources: () => Effect.succeed({}),
    add: () => Effect.succeed({ status: { status: "disabled" as const } }),
    connect: () => Effect.void,
    disconnect: () => Effect.void,
    getPrompt: () => Effect.succeed(undefined),
    readResource: () => Effect.succeed(undefined),
    startAuth: () => Effect.die("unexpected MCP auth"),
    authenticate: () => Effect.die("unexpected MCP auth"),
    finishAuth: () => Effect.die("unexpected MCP auth"),
    removeAuth: () => Effect.void,
    supportsOAuth: () => Effect.succeed(false),
    hasStoredTokens: () => Effect.succeed(false),
    getAuthStatus: () => Effect.succeed("not_authenticated" as const),
  }),
)

const lsp = Layer.succeed(
  LSP.Service,
  LSP.Service.of({
    init: () => Effect.void,
    status: () => Effect.succeed([]),
    hasClients: () => Effect.succeed(false),
    touchFile: () => Effect.void,
    diagnostics: () => Effect.succeed({}),
    hover: () => Effect.succeed(undefined),
    definition: () => Effect.succeed([]),
    references: () => Effect.succeed([]),
    implementation: () => Effect.succeed([]),
    documentSymbol: () => Effect.succeed([]),
    workspaceSymbol: () => Effect.succeed([]),
    prepareCallHierarchy: () => Effect.succeed([]),
    incomingCalls: () => Effect.succeed([]),
    outgoingCalls: () => Effect.succeed([]),
  }),
)

const root = LayerNode.group([
  SessionPrompt.node,
  Session.node,
  SessionProjector.node,
  SessionSummary.node,
  Database.node,
  EventV2Bridge.node,
  CrossSpawnSpawner.node,
  LayerNode.make(TestLLMServer.layer, []),
])

const it = testEffect(
  LayerNode.buildLayer(root, {
    replacements: [
      LayerNode.replace(MCP.node, mcp),
      LayerNode.replace(LSP.node, lsp),
      LayerNode.replace(RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })),
    ],
  }),
)

const providerConfig = (url: string) => ({
  provider: {
    test: {
      name: "Test",
      id: "test",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      models: {
        "test-model": {
          id: "test-model",
          name: "Test Model",
          attachment: false,
          reasoning: false,
          temperature: false,
          tool_call: true,
          release_date: "2025-01-01",
          limit: { context: 100000, output: 10000 },
          cost: { input: 0, output: 0 },
          options: {},
        },
      },
      options: {
        apiKey: "test-key",
        baseURL: url,
      },
    },
  },
})

it.live("mirrors prompt agent and model switches into the directory session log", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ dir }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "prompt switch jsonl" })

      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        model: { providerID: "test" as never, modelID: "test-model" as never },
        noReply: true,
        parts: [{ type: "text", text: "seed only" }],
      })

      const restored = yield* Effect.promise(() => readSessionStore(dir, session.id))

      expect(restored?.agent).toBe("build")
      expect(restored?.model).toMatchObject({
        id: "test-model",
        providerID: "test",
      })
    }),
    { config: providerConfig },
  ),
)

it.live("mirrors session errors into the directory session log", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* () {
      const events = yield* EventV2Bridge.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "session error jsonl" })
      const error = { name: "ContentFilterError", data: { message: "failed" } } as const

      yield* events.publish(Session.Event.Error, { sessionID: session.id, error })

      const raw = yield* Effect.promise(() =>
        fs.readFile(path.join(session.directory, ".agents", "atree", "sessions", session.id, "session.jsonl"), "utf8"),
      )
      const entries = raw
        .trim()
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>)

      expect(entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "session.error",
            sessionID: session.id,
            error,
          }),
        ]),
      )
    }),
    { config: providerConfig },
  ),
)

it.live("mirrors executed commands into the directory session log", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* () {
      const events = yield* EventV2Bridge.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "command jsonl" })

      yield* events.publish(Command.Event.Executed, {
        name: "init",
        sessionID: session.id,
        arguments: "now",
        messageID: "msg_command_jsonl" as never,
      })

      const raw = yield* Effect.promise(() =>
        fs.readFile(path.join(session.directory, ".agents", "atree", "sessions", session.id, "session.jsonl"), "utf8"),
      )
      const entries = raw
        .trim()
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>)

      expect(entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "command.executed",
            name: "init",
            sessionID: session.id,
            arguments: "now",
            messageID: "msg_command_jsonl",
          }),
        ]),
      )
    }),
    { config: providerConfig },
  ),
)

it.live("mirrors compaction completion into the directory session log", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* () {
      const events = yield* EventV2Bridge.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "compaction jsonl" })

      yield* events.publish(SessionCompaction.Event.Compacted, { sessionID: session.id })

      const raw = yield* Effect.promise(() =>
        fs.readFile(path.join(session.directory, ".agents", "atree", "sessions", session.id, "session.jsonl"), "utf8"),
      )
      const entries = raw
        .trim()
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>)

      expect(entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "session.compacted",
            sessionID: session.id,
          }),
        ]),
      )
    }),
    { config: providerConfig },
  ),
)

it.live("mirrors triggered schedules into the directory session log", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* () {
      const events = yield* EventV2Bridge.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "schedule trigger jsonl" })

      yield* events.publish(Schedule.Event.Triggered, {
        scheduleID: "sch_trigger_jsonl" as never,
        sessionID: session.id,
        message: "scheduled hello",
      })

      const raw = yield* Effect.promise(() =>
        fs.readFile(path.join(session.directory, ".agents", "atree", "sessions", session.id, "session.jsonl"), "utf8"),
      )
      const entries = raw
        .trim()
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>)

      expect(entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "schedule.triggered",
            scheduleID: "sch_trigger_jsonl",
            sessionID: session.id,
            message: "scheduled hello",
          }),
        ]),
      )
    }),
    { config: providerConfig },
  ),
)
