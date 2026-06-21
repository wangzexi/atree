import { describe, expect } from "bun:test"
import { Database } from "@opencode-ai/core/database/database"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { Effect, Layer } from "effect"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { resolveFileSession } from "../../src/atree/session-resolver"
import { writeSessionStore } from "../../src/atree/session-store"
import { writeWorkspaceRoot } from "../../src/atree/state"
import { testEffect } from "../lib/effect"

const database = Database.layerFromPath(":memory:")
const it = testEffect(Layer.mergeAll(database))

describe("atree session resolver", () => {
  it.effect("prefers the persisted root copy over a still-valid SQLite directory row", () =>
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "atree-resolver-root-"))),
        (dir) => Effect.promise(() => fs.rm(dir, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      const data = yield* Effect.acquireRelease(
        Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "atree-resolver-data-"))),
        (dir) => Effect.promise(() => fs.rm(dir, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      const source = path.join(root, "source")
      const target = path.join(root, "target")
      yield* Effect.promise(() => fs.mkdir(source, { recursive: true }))
      yield* Effect.promise(() => fs.mkdir(target, { recursive: true }))
      const previousData = process.env.OPENCODE_DATA
      process.env.OPENCODE_DATA = data
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (previousData === undefined) delete process.env.OPENCODE_DATA
          else process.env.OPENCODE_DATA = previousData
        }),
      )
      yield* Effect.promise(() => writeWorkspaceRoot(root))

      const sessionID = "ses_resolver_root_copy" as never
      const base = {
        id: sessionID,
        slug: "resolver-root-copy",
        version: "test",
        projectID: "global" as never,
        path: ".",
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: 1, updated: 1 },
      }
      yield* Effect.promise(() => writeSessionStore({ ...base, directory: source, title: "Source cache" } as never))
      yield* Effect.promise(() => writeSessionStore({ ...base, directory: target, title: "Target root copy" } as never))

      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: "global", worktree: source, sandboxes: [] } as unknown as typeof ProjectTable.$inferInsert)
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: "global" as never,
          slug: "resolver-root-copy",
          directory: source,
          title: "Source cache",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)

      const resolved = yield* resolveFileSession(db, { sessionID })

      expect(resolved?.directory).toBe(yield* Effect.promise(() => fs.realpath(target)))
      expect(resolved?.title).toBe("Target root copy")
    }),
  )
})
