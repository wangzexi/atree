import { describe, expect } from "bun:test"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { Global } from "@opencode-ai/core/global"
import { Project } from "@opencode-ai/core/project"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Prompt } from "@opencode-ai/core/session/prompt"
import { SessionStore } from "@opencode-ai/core/session/store"
import { DateTime, Effect, Layer } from "effect"
import { mkdir, mkdtemp, realpath, writeFile } from "fs/promises"
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
