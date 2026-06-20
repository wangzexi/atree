import { describe, expect } from "bun:test"
import { Deferred, Effect, Layer } from "effect"
import { Project } from "@/project/project"
import { Session as SessionNs } from "@/session/session"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { provideInstance, TestInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { writeSessionStore } from "@/atree/session-store"
import { InstanceState } from "@/effect/instance-state"
import fs from "fs/promises"
import path from "path"

const it = testEffect(Layer.mergeAll(SessionNs.defaultLayer, Project.defaultLayer, CrossSpawnSpawner.defaultLayer))

const withSession = (input?: Parameters<SessionNs.Interface["create"]>[0]) =>
  Effect.acquireRelease(SessionNs.use.create(input), (created) =>
    SessionNs.Service.use((session) => session.remove(created.id).pipe(Effect.ignore)),
  )

describe("session.listGlobal", () => {
  it.instance(
    "lists sessions across projects with project metadata",
    () =>
      Effect.gen(function* () {
        const first = yield* TestInstance
        const second = yield* tmpdirScoped({ git: true })

        const firstSession = yield* withSession({ title: "first-session" })
        const secondSession = yield* withSession({ title: "second-session" }).pipe(provideInstance(second))

        const sessions = yield* SessionNs.Service.use((session) => session.listGlobal({ limit: 200 }))
        const ids = sessions.map((session) => session.id)

        expect(ids).toContain(firstSession.id)
        expect(ids).toContain(secondSession.id)

        const firstProject = yield* Project.use.get(firstSession.projectID)
        const secondProject = yield* Project.use.get(secondSession.projectID)

        const firstItem = sessions.find((session) => session.id === firstSession.id)
        const secondItem = sessions.find((session) => session.id === secondSession.id)

        expect(firstItem?.project?.id).toBe(firstProject?.id)
        expect(firstItem?.project?.worktree).toBe(firstProject?.worktree)
        expect(secondItem?.project?.id).toBe(secondProject?.id)
        expect(secondItem?.project?.worktree).toBe(secondProject?.worktree)
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
