import { describe, expect } from "bun:test"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { Global } from "@opencode-ai/core/global"
import { Project } from "@opencode-ai/core/project"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionProjector } from "@opencode-ai/core/session/projector"
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
})
