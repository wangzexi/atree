import { afterEach, describe, expect } from "bun:test"
import { $ } from "bun"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Session as SessionNs } from "@/session/session"
import { disposeAllInstances, provideInstance, TestInstance } from "../fixture/fixture"
import { cp, mkdir, rm } from "fs/promises"
import path from "path"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { eq } from "drizzle-orm"
import { testEffect } from "../lib/effect"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Storage } from "@/storage/storage"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { BackgroundJob } from "@/background/job"
import { writeSessionStore } from "@/atree/session-store"
import { InstanceState } from "@/effect/instance-state"

const layer = (experimentalWorkspaces: boolean) =>
  Layer.mergeAll(
    Database.defaultLayer,
    SessionNs.layer.pipe(
      Layer.provide(EventV2Bridge.defaultLayer),
      Layer.provide(Storage.defaultLayer),
      Layer.provide(Database.defaultLayer),
      Layer.provide(EventV2Bridge.defaultLayer),
      Layer.provide(SessionProjector.defaultLayer),
      Layer.provide(RuntimeFlags.layer({ experimentalWorkspaces })),
      Layer.provide(BackgroundJob.defaultLayer),
    ),
  )
const it = testEffect(layer(false))
const itWorkspaces = testEffect(layer(true))

const withSession = (input?: Parameters<SessionNs.Interface["create"]>[0]) =>
  Effect.acquireRelease(SessionNs.use.create(input), (created) =>
    SessionNs.Service.use((session) => session.remove(created.id).pipe(Effect.ignore)),
  )

const initGitRoot = (directory: string) =>
  Effect.promise(async () => {
    await mkdir(directory, { recursive: true })
    await $`git init`.cwd(directory).quiet()
    await $`git config core.fsmonitor false`.cwd(directory).quiet()
    await $`git config commit.gpgsign false`.cwd(directory).quiet()
    await $`git config user.email "test@opencode.test"`.cwd(directory).quiet()
    await $`git config user.name "Test"`.cwd(directory).quiet()
    await $`git commit --allow-empty -m "root commit ${directory}"`.cwd(directory).quiet()
  })

afterEach(async () => {
  await disposeAllInstances()
})

describe("session.list", () => {
  it.instance(
    "does not filter by directory when directory is omitted",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* Effect.promise(() => mkdir(path.join(test.directory, "packages", "opencode"), { recursive: true }))
        yield* Effect.promise(() => mkdir(path.join(test.directory, "packages", "app"), { recursive: true }))

        const root = yield* withSession({ title: "root" })
        const parent = yield* withSession({ title: "parent" }).pipe(
          provideInstance(path.join(test.directory, "packages")),
        )
        const current = yield* withSession({ title: "current" }).pipe(
          provideInstance(path.join(test.directory, "packages", "opencode")),
        )
        const sibling = yield* withSession({ title: "sibling" }).pipe(
          provideInstance(path.join(test.directory, "packages", "app")),
        )

        const ids = (yield* SessionNs.use.list()).map((session) => session.id)
        expect(ids).toContain(root.id)
        expect(ids).toContain(parent.id)
        expect(ids).toContain(current.id)
        expect(ids).toContain(sibling.id)
      }),
    { git: true },
  )

  it.instance(
    "filters by directory when directory is provided",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* Effect.promise(() => mkdir(path.join(test.directory, "packages", "opencode"), { recursive: true }))
        yield* Effect.promise(() => mkdir(path.join(test.directory, "packages", "app"), { recursive: true }))

        const root = yield* withSession({ title: "root" })
        const parent = yield* withSession({ title: "parent" }).pipe(
          provideInstance(path.join(test.directory, "packages")),
        )
        const current = yield* withSession({ title: "current" }).pipe(
          provideInstance(path.join(test.directory, "packages", "opencode")),
        )
        const sibling = yield* withSession({ title: "sibling" }).pipe(
          provideInstance(path.join(test.directory, "packages", "app")),
        )

        const ids = (yield* SessionNs.Service.use((session) =>
          session.list({ directory: path.join(test.directory, "packages", "opencode") }),
        )).map((session) => session.id)
        expect(ids).not.toContain(root.id)
        expect(ids).not.toContain(parent.id)
        expect(ids).toContain(current.id)
        expect(ids).not.toContain(sibling.id)
      }),
    { git: true },
  )

  it.instance(
    "loads copied directory session stores as belonging to the target directory",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const source = path.join(test.directory, "source-project")
        const target = path.join(test.directory, "target-project")
        yield* initGitRoot(source)
        yield* initGitRoot(target)

        const created = yield* withSession({ title: "copied-directory-session", metadata: { icon: "🧭" } }).pipe(
          provideInstance(source),
        )
        yield* Effect.promise(() => cp(path.join(source, ".agents"), path.join(target, ".agents"), { recursive: true }))
        const sourceCtx = yield* provideInstance(source)(InstanceState.context)
        const targetCtx = yield* provideInstance(target)(InstanceState.context)
        expect(sourceCtx.project.id).not.toBe(targetCtx.project.id)

        const targetSessions = yield* SessionNs.Service.use((session) =>
          provideInstance(target)(session.list({ directory: target, roots: true })),
        )
        const copied = targetSessions.find((item) => item.id === created.id)
        expect(copied?.directory).toBe(target)
        expect(copied?.projectID).toBe(targetCtx.project.id)
        expect(copied?.title).toBe("copied-directory-session")
        expect(copied?.metadata).toEqual({ icon: "🧭" })

        const loaded = yield* SessionNs.Service.use((session) => provideInstance(target)(session.get(created.id)))
        expect(loaded.directory).toBe(target)
        expect(loaded.projectID).toBe(targetCtx.project.id)
        expect(loaded.title).toBe("copied-directory-session")
      }),
    { git: true },
  )

  it.instance(
    "filters archived file-backed sessions unless requested",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const directory = test.directory

        yield* Effect.promise(() =>
          writeSessionStore({
            id: "ses_file_active",
            slug: "file-active",
            version: "test",
            projectID: "proj_file",
            directory,
            path: ".",
            title: "File active",
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: 1, updated: 1 },
          } as any),
        )
        yield* Effect.promise(() =>
          writeSessionStore({
            id: "ses_file_archived",
            slug: "file-archived",
            version: "test",
            projectID: "proj_file",
            directory,
            path: ".",
            title: "File archived",
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: 2, updated: 2, archived: 3 },
          } as any),
        )

        const sessions = yield* SessionNs.Service.use((session) => session.list({ directory, roots: true }))
        const byID = new Map(sessions.map((session) => [String(session.id), session]))
        expect(byID.get("ses_file_active")?.time.archived).toBeUndefined()
        expect(byID.has("ses_file_archived")).toBe(false)

        const withArchived = yield* SessionNs.Service.use((session) =>
          session.list({ directory, roots: true, archived: true }),
        )
        const archivedByID = new Map(withArchived.map((session) => [String(session.id), session]))
        expect(archivedByID.get("ses_file_archived")?.time.archived).toBe(3)
      }),
    { git: true },
  )

  it.instance(
    "prefers archived file metadata over stale active database rows",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const stale = yield* withSession({ title: "stale-active-list-cache" })
        const archivedAt = Date.now()

        yield* Effect.promise(() =>
          writeSessionStore({
            ...stale,
            time: { ...stale.time, archived: archivedAt },
          } as any),
        )

        const activeIDs = (yield* SessionNs.Service.use((session) =>
          session.list({ directory: test.directory, roots: true }),
        )).map((session) => session.id)
        expect(activeIDs).not.toContain(stale.id)

        const withArchived = yield* SessionNs.Service.use((session) =>
          session.list({ directory: test.directory, roots: true, archived: true }),
        )
        expect(withArchived.find((session) => session.id === stale.id)?.time.archived).toBe(archivedAt)
      }),
    { git: true },
  )

  it.instance(
    "filters file-backed sessions by path without requiring SQLite rows",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const directory = test.directory

        const base = {
          slug: "file-path",
          version: "test",
          projectID: "proj_file_path",
          directory,
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        }
        yield* Effect.promise(() =>
          Promise.all([
            writeSessionStore({
              ...base,
              id: "ses_file_path_current",
              path: "packages/opencode/src",
              title: "File path current",
              time: { created: 1, updated: 30 },
            } as any),
            writeSessionStore({
              ...base,
              id: "ses_file_path_deeper",
              path: "packages/opencode/src/deep",
              title: "File path deeper",
              time: { created: 2, updated: 40 },
            } as any),
            writeSessionStore({
              ...base,
              id: "ses_file_path_parent",
              path: "packages/opencode",
              title: "File path parent",
              time: { created: 3, updated: 50 },
            } as any),
            writeSessionStore({
              ...base,
              id: "ses_file_path_legacy",
              path: undefined,
              title: "File path legacy",
              time: { created: 4, updated: 20 },
            } as any),
            writeSessionStore({
              ...base,
              id: "ses_file_path_archived",
              path: "packages/opencode/src",
              title: "File path archived",
              time: { created: 5, updated: 60, archived: 61 },
            } as any),
          ]),
        )

        const ids = (yield* SessionNs.Service.use((session) =>
          session.list({ directory, path: "packages/opencode/src" }),
        )).map((session) => String(session.id))

        expect(ids).toContain("ses_file_path_current")
        expect(ids).toContain("ses_file_path_deeper")
        expect(ids).toContain("ses_file_path_legacy")
        expect(ids).not.toContain("ses_file_path_parent")
        expect(ids).not.toContain("ses_file_path_archived")

        const archivedIDs = (yield* SessionNs.Service.use((session) =>
          session.list({ directory, path: "packages/opencode/src", archived: true }),
        )).map((session) => String(session.id))
        expect(archivedIDs).toContain("ses_file_path_archived")
      }),
    { git: true },
  )

  it.instance(
    "does not revive stale SQLite rows for path lists after the file-backed session store is removed",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const directory = path.join(test.directory, "packages", "opencode", "src")
        yield* Effect.promise(() => mkdir(directory, { recursive: true }))

        const created = yield* withSession({ title: "stale-path-session" }).pipe(provideInstance(directory))

        const beforeIDs = (yield* SessionNs.Service.use((session) =>
          session.list({ path: "packages/opencode/src" }),
        )).map((session) => session.id)
        expect(beforeIDs).toContain(created.id)

        yield* Effect.promise(() => rm(path.join(directory, ".agents", "atree", "sessions", created.id), { recursive: true, force: true }))

        const afterIDs = (yield* SessionNs.Service.use((session) =>
          session.list({ path: "packages/opencode/src" }),
        )).map((session) => session.id)
        expect(afterIDs).not.toContain(created.id)
      }),
    { git: true },
  )

  itWorkspaces.instance(
    "filters by directory when experimental workspaces are enabled",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* Effect.promise(() => mkdir(path.join(test.directory, "packages", "opencode"), { recursive: true }))
        yield* Effect.promise(() => mkdir(path.join(test.directory, "packages", "app"), { recursive: true }))

        const current = yield* withSession({ title: "current" }).pipe(
          provideInstance(path.join(test.directory, "packages", "opencode")),
        )
        const sibling = yield* withSession({ title: "sibling" }).pipe(
          provideInstance(path.join(test.directory, "packages", "app")),
        )

        const ids = (yield* SessionNs.Service.use((session) =>
          session.list({ directory: path.join(test.directory, "packages", "opencode") }),
        )).map((session) => session.id)
        expect(ids).toContain(current.id)
        expect(ids).not.toContain(sibling.id)
      }),
    { git: true },
  )

  it.instance(
    "matches a session regardless of directory separator on Windows",
    () =>
      Effect.gen(function* () {
        if (process.platform !== "win32") return
        const test = yield* TestInstance
        const dir = path.join(test.directory, "packages", "opencode")
        yield* Effect.promise(() => mkdir(dir, { recursive: true }))

        const created = yield* withSession({ title: "separator" }).pipe(provideInstance(dir))

        // A forward-slash query (e.g. from the SDK/HTTP layer) must still find it —
        // this is the regression: backslash-stored vs forward-slash-queried.
        const forwardIDs = (yield* SessionNs.Service.use((session) =>
          session.list({ directory: dir.replaceAll("\\", "/") }),
        )).map((session) => session.id)
        expect(forwardIDs).toContain(created.id)

        // The native form must keep matching too.
        const nativeIDs = (yield* SessionNs.Service.use((session) => session.list({ directory: dir }))).map(
          (session) => session.id,
        )
        expect(nativeIDs).toContain(created.id)
      }),
    { git: true },
  )

  it.instance(
    "filters by path and ignores directory when path is provided",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* Effect.promise(() =>
          mkdir(path.join(test.directory, "packages", "opencode", "src", "deep"), { recursive: true }),
        )
        yield* Effect.promise(() => mkdir(path.join(test.directory, "packages", "app"), { recursive: true }))

        const parent = yield* withSession({ title: "parent" }).pipe(
          provideInstance(path.join(test.directory, "packages", "opencode")),
        )
        const current = yield* withSession({ title: "current" }).pipe(
          provideInstance(path.join(test.directory, "packages", "opencode", "src")),
        )
        const deeper = yield* withSession({ title: "deeper" }).pipe(
          provideInstance(path.join(test.directory, "packages", "opencode", "src", "deep")),
        )
        const sibling = yield* withSession({ title: "sibling" }).pipe(
          provideInstance(path.join(test.directory, "packages", "app")),
        )

        const pathIDs = (yield* SessionNs.Service.use((session) =>
          session.list({
            directory: path.join(test.directory, "packages", "app"),
            path: "packages/opencode/src",
          }),
        )).map((session) => session.id)
        expect(pathIDs).not.toContain(parent.id)
        expect(pathIDs).toContain(current.id)
        expect(pathIDs).toContain(deeper.id)
        expect(pathIDs).not.toContain(sibling.id)

        if (process.platform === "win32") {
          const windowsPathIDs = (yield* SessionNs.Service.use((session) =>
            session.list({ path: "packages\\opencode\\src" }),
          )).map((session) => session.id)
          expect(windowsPathIDs).toContain(current.id)
          expect(windowsPathIDs).toContain(deeper.id)
        }
      }),
    { git: true },
  )

  it.instance(
    "falls back to directory when filtering legacy sessions without path",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* Effect.promise(() =>
          mkdir(path.join(test.directory, "packages", "opencode", "src"), { recursive: true }),
        )
        yield* Effect.promise(() => mkdir(path.join(test.directory, "packages", "app"), { recursive: true }))

        const current = yield* withSession({ title: "legacy-current" }).pipe(
          provideInstance(path.join(test.directory, "packages", "opencode", "src")),
        )
        const sibling = yield* withSession({ title: "legacy-sibling" }).pipe(
          provideInstance(path.join(test.directory, "packages", "app")),
        )

        const { db } = yield* Database.Service
        yield* db
          .update(SessionTable)
          .set({ path: null })
          .where(eq(SessionTable.id, current.id))
          .run()
          .pipe(Effect.orDie)
        yield* db
          .update(SessionTable)
          .set({ path: null })
          .where(eq(SessionTable.id, sibling.id))
          .run()
          .pipe(Effect.orDie)

        const pathIDs = (yield* SessionNs.Service.use((session) =>
          session.list({
            directory: path.join(test.directory, "packages", "opencode", "src"),
            path: "packages/opencode/src",
          }),
        )).map((session) => session.id)
        expect(pathIDs).toContain(current.id)
        expect(pathIDs).not.toContain(sibling.id)
      }),
    { git: true },
  )

  it.instance(
    "filters root sessions",
    () =>
      Effect.gen(function* () {
        const root = yield* withSession({ title: "root-session" })
        const child = yield* withSession({ title: "child-session", parentID: root.id })

        const sessions = yield* SessionNs.use.list({ roots: true })
        const ids = sessions.map((session) => session.id)

        expect(ids).toContain(root.id)
        expect(ids).not.toContain(child.id)
      }),
    { git: true },
  )

  it.instance(
    "filters by start time",
    () =>
      Effect.gen(function* () {
        yield* withSession({ title: "new-session" })
        const sessions = yield* SessionNs.Service.use((session) => session.list({ start: Date.now() + 86400000 }))
        expect(sessions.length).toBe(0)
      }),
    { git: true },
  )

  it.instance(
    "filters by search term",
    () =>
      Effect.gen(function* () {
        yield* withSession({ title: "unique-search-term-abc" })
        yield* withSession({ title: "other-session-xyz" })

        const sessions = yield* SessionNs.use.list({ search: "unique-search" })
        const titles = sessions.map((session) => session.title)

        expect(titles).toContain("unique-search-term-abc")
        expect(titles).not.toContain("other-session-xyz")
      }),
    { git: true },
  )

  it.instance(
    "respects limit parameter",
    () =>
      Effect.gen(function* () {
        yield* withSession({ title: "session-1" })
        yield* withSession({ title: "session-2" })
        yield* withSession({ title: "session-3" })

        const sessions = yield* SessionNs.use.list({ limit: 2 })
        expect(sessions.length).toBe(2)
      }),
    { git: true },
  )

  it.instance(
    "includes metadata in listed sessions",
    () =>
      Effect.gen(function* () {
        const meta = { source: "sdk", trace: { id: "abc" } }
        const created = yield* withSession({ title: "meta-session", metadata: meta })

        const listed = (yield* SessionNs.Service.use((session) => session.list({ search: "meta-session" }))).find(
          (item) => item.id === created.id,
        )

        expect(listed?.metadata).toEqual(meta)
      }),
    { git: true },
  )
})
