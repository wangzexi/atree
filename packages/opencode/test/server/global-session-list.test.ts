import { afterEach, beforeEach, describe, expect } from "bun:test"
import { Deferred, Effect, Layer } from "effect"
import { Project } from "@/project/project"
import { Session as SessionNs } from "@/session/session"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Global } from "@opencode-ai/core/global"
import { provideInstance, TestInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { writeSessionStore } from "@/atree/session-store"
import { writeWorkspaceRoot } from "@/atree/state"
import { InstanceState } from "@/effect/instance-state"
import fs from "fs/promises"
import os from "os"
import path from "path"

const it = testEffect(Layer.mergeAll(SessionNs.defaultLayer, Project.defaultLayer, CrossSpawnSpawner.defaultLayer))
const temps: string[] = []
let previousData = Global.Path.data

beforeEach(async () => {
  previousData = Global.Path.data
  const data = await fs.mkdtemp(path.join(os.tmpdir(), "atree-global-session-data-"))
  temps.push(data)
  ;(Global.Path as { data: string }).data = data
})

afterEach(async () => {
  ;(Global.Path as { data: string }).data = previousData
  await Promise.all(temps.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

const withSession = (input?: Parameters<SessionNs.Interface["create"]>[0]) =>
  Effect.acquireRelease(SessionNs.use.create(input), (created) =>
    SessionNs.Service.use((session) => session.remove(created.id).pipe(Effect.ignore)),
  )

describe("session.listGlobal", () => {
  it.instance(
    "scopes an unqualified global list to the current instance when no atree root is persisted",
    () =>
      Effect.gen(function* () {
        const first = yield* TestInstance
        const second = yield* tmpdirScoped({ git: true })

        const firstSession = yield* withSession({ title: "first-session" })
        const secondSession = yield* withSession({ title: "second-session" }).pipe(provideInstance(second))

        const sessions = yield* SessionNs.Service.use((session) => session.listGlobal({ limit: 200 }))
        const ids = sessions.map((session) => session.id)

        expect(ids).toContain(firstSession.id)
        expect(ids).not.toContain(secondSession.id)

        const firstProject = yield* Project.use.get(firstSession.projectID)

        const firstItem = sessions.find((session) => session.id === firstSession.id)

        expect(firstItem?.project?.id).toBe(firstProject?.id)
        expect(firstItem?.project?.worktree).toBe(firstProject?.worktree)
        expect(first.directory).not.toBe(second)
      }),
    { git: true },
  )

  it.instance(
    "excludes archived sessions by default",
    () =>
      Effect.gen(function* () {
        const archived = yield* withSession({ title: "archived-session" })

        yield* SessionNs.Service.use((session) => session.setArchived({ sessionID: archived.id, time: Date.now() }))

        const sessions = yield* SessionNs.Service.use((session) => session.listGlobal({ limit: 200 }))
        const ids = sessions.map((session) => session.id)

        expect(ids).not.toContain(archived.id)

        const allSessions = yield* SessionNs.Service.use((session) =>
          session.listGlobal({ limit: 200, archived: true }),
        )
        const allIds = allSessions.map((session) => session.id)

        expect(allIds).toContain(archived.id)
      }),
    { git: true },
  )

  it.instance(
    "includes file-backed sessions when listing a directory globally",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const ctx = yield* InstanceState.context

        yield* Effect.promise(() =>
          writeSessionStore({
            id: "ses_global_file_active",
            slug: "global-file-active",
            version: "test",
            projectID: ctx.project.id,
            directory: test.directory,
            path: ".",
            title: "Global file active",
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: 10, updated: 20 },
          } as any),
        )
        yield* Effect.promise(() =>
          writeSessionStore({
            id: "ses_global_file_archived",
            slug: "global-file-archived",
            version: "test",
            projectID: ctx.project.id,
            directory: test.directory,
            path: ".",
            title: "Global file archived",
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: 11, updated: 21, archived: 22 },
          } as any),
        )

        const sessions = yield* SessionNs.Service.use((session) =>
          session.listGlobal({ directory: test.directory, limit: 200 }),
        )
        const ids = sessions.map((session) => String(session.id))
        expect(ids).toContain("ses_global_file_active")
        expect(ids).not.toContain("ses_global_file_archived")
        expect(sessions.find((session) => String(session.id) === "ses_global_file_active")?.project?.id).toBe(
          ctx.project.id,
        )

        const archived = yield* SessionNs.Service.use((session) =>
          session.listGlobal({ directory: test.directory, archived: true, limit: 200 }),
        )
        expect(archived.map((session) => String(session.id))).toContain("ses_global_file_archived")
      }),
    { git: true },
  )

  it.instance(
    "includes file-backed sessions from the persisted atree root when no directory is provided",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const ctx = yield* InstanceState.context
        yield* Effect.promise(() => writeWorkspaceRoot(test.directory))

        yield* Effect.promise(() =>
          writeSessionStore({
            id: "ses_global_root_file_only",
            slug: "global-root-file-only",
            version: "test",
            projectID: ctx.project.id,
            directory: test.directory,
            path: ".",
            title: "Global root file only",
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: 10, updated: Date.now() },
          } as any),
        )

        const sessions = yield* SessionNs.Service.use((session) => session.listGlobal({ limit: 200 }))
        const fileOnly = sessions.find((session) => String(session.id) === "ses_global_root_file_only")
        expect(fileOnly?.directory).toBe(test.directory)
        expect(fileOnly?.project?.id).toBe(ctx.project.id)
      }),
    { git: true },
  )

  it.instance(
    "keeps copied file-backed sessions distinct across directories in the persisted atree root",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const ctx = yield* InstanceState.context
        yield* Effect.promise(() => writeWorkspaceRoot(test.directory))

        const source = path.join(test.directory, "source")
        const target = path.join(test.directory, "target")
        yield* Effect.promise(() => fs.mkdir(source, { recursive: true }))
        yield* Effect.promise(() => fs.mkdir(target, { recursive: true }))

        const base = {
          id: "ses_global_root_copied",
          slug: "global-root-copied",
          version: "test",
          projectID: ctx.project.id,
          path: ".",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 10, updated: Date.now() },
        }

        yield* Effect.promise(() =>
          writeSessionStore({
            ...base,
            directory: source,
            title: "Global copied source",
          } as any),
        )
        yield* Effect.promise(() =>
          writeSessionStore({
            ...base,
            directory: target,
            title: "Global copied target",
          } as any),
        )

        const sessions = yield* SessionNs.Service.use((session) => session.listGlobal({ limit: 200 }))
        const copied = sessions.filter((session) => String(session.id) === "ses_global_root_copied")

        expect(copied.map((session) => session.directory).sort()).toEqual([source, target].sort())
        expect(copied.map((session) => session.title).sort()).toEqual(
          ["Global copied source", "Global copied target"].sort(),
        )
      }),
    { git: true },
  )

  it.instance(
    "excludes sessions outside the persisted atree root when no directory is provided",
    () =>
      Effect.gen(function* () {
        const root = yield* TestInstance
        const outside = yield* tmpdirScoped({ git: true })
        yield* Effect.promise(() => writeWorkspaceRoot(root.directory))

        const rootSession = yield* withSession({ title: "root-scoped-session" })
        const outsideSession = yield* withSession({ title: "outside-root-session" }).pipe(provideInstance(outside))

        const sessions = yield* SessionNs.Service.use((session) => session.listGlobal({ limit: 200, archived: true }))
        const ids = sessions.map((session) => session.id)

        expect(ids).toContain(rootSession.id)
        expect(ids).not.toContain(outsideSession.id)
      }),
    { git: true },
  )

  it.instance(
    "prefers archived file metadata over stale active rows in global lists",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const stale = yield* withSession({ title: "global-stale-active-cache" })
        const archivedAt = Date.now()

        yield* Effect.promise(() =>
          writeSessionStore({
            ...stale,
            time: { ...stale.time, archived: archivedAt },
          } as any),
        )

        const sessions = yield* SessionNs.Service.use((session) =>
          session.listGlobal({ directory: test.directory, limit: 200 }),
        )
        expect(sessions.map((session) => session.id)).not.toContain(stale.id)

        const archived = yield* SessionNs.Service.use((session) =>
          session.listGlobal({ directory: test.directory, archived: true, limit: 200 }),
        )
        expect(archived.find((session) => session.id === stale.id)?.time.archived).toBe(archivedAt)
      }),
    { git: true },
  )

  it.instance(
    "ignores stale cache rows that no longer have a directory session store",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const cachedOnly = yield* withSession({ title: "global-stale-cache-only" })

        yield* Effect.promise(() =>
          fs.rm(path.join(test.directory, ".agents", "atree", "sessions", cachedOnly.id), {
            recursive: true,
            force: true,
          }),
        )

        const sessions = yield* SessionNs.Service.use((session) =>
          session.listGlobal({ directory: test.directory, limit: 200 }),
        )
        expect(sessions.map((session) => session.id)).not.toContain(cachedOnly.id)

        const archived = yield* SessionNs.Service.use((session) =>
          session.listGlobal({ directory: test.directory, archived: true, limit: 200 }),
        )
        expect(archived.map((session) => session.id)).not.toContain(cachedOnly.id)
      }),
    { git: true },
  )

  it.instance(
    "supports cursor pagination",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance

        const first = yield* withSession({ title: "page-one" })
        const ready = yield* Deferred.make<void>()
        yield* Deferred.succeed(ready, undefined).pipe(Effect.delay("5 millis"), Effect.forkScoped)
        yield* Deferred.await(ready).pipe(
          Effect.timeoutOrElse({
            duration: "1 second",
            orElse: () => Effect.fail(new Error("timed out waiting between session creates")),
          }),
        )
        const second = yield* withSession({ title: "page-two" })

        const page = yield* SessionNs.Service.use((session) =>
          session.listGlobal({ directory: test.directory, limit: 1 }),
        )
        expect(page.length).toBe(1)
        expect(page[0].id).toBe(second.id)

        const next = yield* SessionNs.Service.use((session) =>
          session.listGlobal({ directory: test.directory, limit: 10, cursor: page[0].time.updated }),
        )
        const ids = next.map((session) => session.id)

        expect(ids).toContain(first.id)
        expect(ids).not.toContain(second.id)
      }),
    { git: true },
  )
})
