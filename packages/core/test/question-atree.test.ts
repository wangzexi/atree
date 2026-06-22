import { describe, expect } from "bun:test"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { Global } from "@opencode-ai/core/global"
import { QuestionV2 } from "@opencode-ai/core/question"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionStore } from "@opencode-ai/core/session/store"
import { Effect, Layer } from "effect"
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises"
import os from "os"
import path from "path"
import { testEffect } from "./lib/effect"

const database = Database.layerFromPath(":memory:")
const events = EventV2.layer.pipe(Layer.provide(database))
const store = SessionStore.layer.pipe(Layer.provide(database))
const questions = QuestionV2.layer.pipe(Layer.provide(events), Layer.provide(store))
const it = testEffect(Layer.mergeAll(database, events, store, questions))

async function writeAtreeSession(input: {
  data: string
  root: string
  directory: string
  sessionID: string
  title: string
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
      `updatedAt: 20`,
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

describe("QuestionV2 atree state", () => {
  it.effect("restores pending questions from directory session.jsonl and appends replies", () =>
    Effect.gen(function* () {
      const data = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "atree-core-question-data-"))),
        (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "atree-core-question-root-"))),
        (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      const node = path.join(root, "inbox")
      const previousData = Global.Path.data
      ;(Global.Path as { data: string }).data = data
      yield* Effect.addFinalizer(() => Effect.sync(() => ((Global.Path as { data: string }).data = previousData)))

      const sessionID = SessionV2.ID.make("ses_core_question_restore")
      const pendingID = QuestionV2.ID.ascending("que_core_question_pending")
      const answeredID = QuestionV2.ID.ascending("que_core_question_answered")

      yield* Effect.promise(() =>
        writeAtreeSession({
          data,
          root,
          directory: node,
          sessionID,
          title: "Core question restore",
        }),
      )
      yield* Effect.promise(() =>
        writeSessionJsonl(node, sessionID, [
          {
            type: "question.v2.asked",
            id: pendingID,
            sessionID,
            questions: [
              {
                question: "Restore this question?",
                header: "Restore",
                options: [{ label: "Yes", description: "Keep it pending" }],
              },
            ],
          },
          {
            type: "question.v2.asked",
            id: answeredID,
            sessionID,
            questions: [
              {
                question: "Already answered?",
                header: "Done",
                options: [{ label: "Yes", description: "Do not restore" }],
              },
            ],
          },
          {
            type: "question.v2.replied",
            sessionID,
            requestID: answeredID,
            answers: [["Yes"]],
          },
        ]),
      )

      const service = yield* QuestionV2.Service
      const restored = yield* service.list()
      expect(restored.map((item) => item.id)).toEqual([pendingID])
      expect(restored[0]?.sessionID).toBe(sessionID)

      yield* service.reply({ requestID: pendingID, answers: [["Yes"]] })
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
          type: "question.v2.replied",
          sessionID,
          requestID: pendingID,
          answers: [["Yes"]],
        }),
      )
    }),
  )

  it.effect("removes restored questions when session.jsonl is answered externally", () =>
    Effect.gen(function* () {
      const data = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "atree-core-question-data-"))),
        (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(path.join(os.tmpdir(), "atree-core-question-root-"))),
        (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      const node = path.join(root, "inbox")
      const previousData = Global.Path.data
      ;(Global.Path as { data: string }).data = data
      yield* Effect.addFinalizer(() => Effect.sync(() => ((Global.Path as { data: string }).data = previousData)))

      const sessionID = SessionV2.ID.make("ses_core_question_external_reply")
      const pendingID = QuestionV2.ID.ascending("que_core_question_external")

      yield* Effect.promise(() =>
        writeAtreeSession({
          data,
          root,
          directory: node,
          sessionID,
          title: "Core question external reply",
        }),
      )
      yield* Effect.promise(() =>
        writeSessionJsonl(node, sessionID, [
          {
            type: "question.v2.asked",
            id: pendingID,
            sessionID,
            questions: [
              {
                question: "Answered outside this process?",
                header: "External",
                options: [{ label: "Yes", description: "Remove from pending state" }],
              },
            ],
          },
        ]),
      )

      const service = yield* QuestionV2.Service
      expect((yield* service.list()).map((item) => item.id)).toEqual([pendingID])

      yield* Effect.promise(() =>
        appendFile(
          path.join(node, ".agents", "atree", "sessions", sessionID, "session.jsonl"),
          JSON.stringify({
            type: "question.v2.replied",
            sessionID,
            requestID: pendingID,
            answers: [["Yes"]],
          }) + "\n",
        ),
      )

      expect(yield* service.list()).toEqual([])
    }),
  )
})
