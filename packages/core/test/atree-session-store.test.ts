import { describe, expect } from "bun:test"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { Global } from "@opencode-ai/core/global"
import { Location } from "@opencode-ai/core/location"
import { Project } from "@opencode-ai/core/project"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { FileAttachment, Prompt } from "@opencode-ai/core/session/prompt"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionStore } from "@opencode-ai/core/session/store"
import { eq } from "drizzle-orm"
import { DateTime, Effect, Layer } from "effect"
import { mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from "fs/promises"
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

async function writeAtreeSession(input: {
  root: string
  directory: string
  sessionID: string
  title: string
  createdAt: number
  updatedAt: number
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
      `archivedAt: null`,
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
      expect(jsonl).toBe("")
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
