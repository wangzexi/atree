import { describe, expect } from "bun:test"
import { Database } from "@opencode-ai/core/database/database"
import { Global } from "@opencode-ai/core/global"
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
  it.effect("does not resolve a persisted-root session when copied directories make the session id ambiguous", () =>
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
      const previousData = Global.Path.data
      ;(Global.Path as { data: string }).data = data
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          ;(Global.Path as { data: string }).data = previousData
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

      const resolved = yield* resolveFileSession({ sessionID })

      expect(resolved).toBeUndefined()
    }),
  )

  it.effect("prefers the current instance directory over the persisted root copy", () =>
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "atree-resolver-priority-root-"))),
        (dir) => Effect.promise(() => fs.rm(dir, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      const data = yield* Effect.acquireRelease(
        Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "atree-resolver-priority-data-"))),
        (dir) => Effect.promise(() => fs.rm(dir, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      const rootNode = path.join(root, "root-node")
      const instanceNode = path.join(root, "instance-node")
      yield* Effect.promise(() => fs.mkdir(rootNode, { recursive: true }))
      yield* Effect.promise(() => fs.mkdir(instanceNode, { recursive: true }))
      const previousData = Global.Path.data
      ;(Global.Path as { data: string }).data = data
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          ;(Global.Path as { data: string }).data = previousData
        }),
      )
      yield* Effect.promise(() => writeWorkspaceRoot(root))

      const sessionID = "ses_resolver_instance_priority" as never
      const base = {
        id: sessionID,
        slug: "resolver-instance-priority",
        version: "test",
        projectID: "global" as never,
        path: ".",
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: 1, updated: 1 },
      }
      yield* Effect.promise(() => writeSessionStore({ ...base, directory: rootNode, title: "Root copy" } as never))
      yield* Effect.promise(() =>
        writeSessionStore({ ...base, directory: instanceNode, title: "Instance copy" } as never),
      )

      const _database = yield* Database.Service
      const resolved = yield* resolveFileSession({ sessionID, instanceDirectory: instanceNode })

      expect(resolved?.directory).toBe(path.resolve(instanceNode))
      expect(resolved?.title).toBe("Instance copy")
    }),
  )

  it.effect("prefers a nested session under the current instance directory before persisted-root copies", () =>
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "atree-resolver-instance-nested-root-"))),
        (dir) => Effect.promise(() => fs.rm(dir, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      const data = yield* Effect.acquireRelease(
        Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "atree-resolver-instance-nested-data-"))),
        (dir) => Effect.promise(() => fs.rm(dir, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      const instanceRoot = path.join(root, "instance-root")
      const nested = path.join(instanceRoot, "nested", "target")
      const sibling = path.join(root, "sibling-copy")
      yield* Effect.promise(() => fs.mkdir(nested, { recursive: true }))
      yield* Effect.promise(() => fs.mkdir(sibling, { recursive: true }))
      const previousData = Global.Path.data
      ;(Global.Path as { data: string }).data = data
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          ;(Global.Path as { data: string }).data = previousData
        }),
      )
      yield* Effect.promise(() => writeWorkspaceRoot(root))

      const sessionID = "ses_resolver_instance_nested_priority" as never
      const base = {
        id: sessionID,
        slug: "resolver-instance-nested-priority",
        version: "test",
        projectID: "global" as never,
        path: ".",
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: 1, updated: 1 },
      }
      yield* Effect.promise(() =>
        writeSessionStore({ ...base, directory: nested, title: "Nested instance copy" } as never),
      )
      yield* Effect.promise(() =>
        writeSessionStore({ ...base, directory: sibling, title: "Sibling persisted-root copy" } as never),
      )

      const resolved = yield* resolveFileSession({ sessionID, instanceDirectory: instanceRoot })
      const expected = yield* Effect.promise(() => fs.realpath(nested))

      expect(resolved?.directory).toBe(expected)
      expect(resolved?.title).toBe("Nested instance copy")
    }),
  )

  it.effect("does not use a SQLite directory row as the final file-backed session hint", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.acquireRelease(
        Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "atree-resolver-db-row-"))),
        (dir) => Effect.promise(() => fs.rm(dir, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      const sessionID = "ses_resolver_db_row" as never
      yield* Effect.promise(() =>
        writeSessionStore({
          id: sessionID,
          slug: "resolver-db-row",
          version: "test",
          projectID: "global" as never,
          path: ".",
          directory,
          title: "DB row file-backed session",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 1, updated: 1 },
        } as never),
      )

      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: "global", worktree: directory, sandboxes: [] } as unknown as typeof ProjectTable.$inferInsert)
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: "global" as never,
          slug: "resolver-db-row",
          directory,
          title: "Stale cache title",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)

      const resolved = yield* resolveFileSession({ sessionID })

      expect(resolved).toBeUndefined()
    }),
  )

  it.effect("resolves a nested file-backed session from an explicit root directory hint", () =>
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "atree-resolver-explicit-root-"))),
        (dir) => Effect.promise(() => fs.rm(dir, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      const nested = path.join(root, "projects", "daily")
      yield* Effect.promise(() => fs.mkdir(nested, { recursive: true }))

      const sessionID = "ses_resolver_explicit_root_nested" as never
      yield* Effect.promise(() =>
        writeSessionStore({
          id: sessionID,
          slug: "resolver-explicit-root-nested",
          version: "test",
          projectID: "global" as never,
          path: "projects/daily",
          directory: nested,
          title: "Explicit root nested",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 1, updated: 1 },
        } as never),
      )

      const resolved = yield* resolveFileSession({ sessionID, directory: root })
      const expected = yield* Effect.promise(() => fs.realpath(nested))

      expect(resolved?.directory).toBe(expected)
      expect(resolved?.title).toBe("Explicit root nested")
    }),
  )

  it.effect("does not resolve an explicit root directory when nested copies make the session id ambiguous", () =>
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "atree-resolver-explicit-root-ambiguous-"))),
        (dir) => Effect.promise(() => fs.rm(dir, { recursive: true, force: true })).pipe(Effect.ignore),
      )
      const source = path.join(root, "source")
      const target = path.join(root, "target")
      yield* Effect.promise(() => fs.mkdir(source, { recursive: true }))
      yield* Effect.promise(() => fs.mkdir(target, { recursive: true }))

      const sessionID = "ses_resolver_explicit_root_ambiguous" as never
      const base = {
        id: sessionID,
        slug: "resolver-explicit-root-ambiguous",
        version: "test",
        projectID: "global" as never,
        path: ".",
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: 1, updated: 1 },
      }
      yield* Effect.promise(() => writeSessionStore({ ...base, directory: source, title: "Explicit root source" } as never))
      yield* Effect.promise(() => writeSessionStore({ ...base, directory: target, title: "Explicit root target" } as never))

      const resolved = yield* resolveFileSession({ sessionID, directory: root })

      expect(resolved).toBeUndefined()
    }),
  )
})
