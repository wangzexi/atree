import { describe, expect } from "bun:test"
import path from "path"
import { Cause, DateTime, Effect, Exit, Fiber, Layer, Option } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { Config } from "@opencode-ai/core/config"
import { ConfigToolOutput } from "@opencode-ai/core/config/tool-output"
import { Database } from "@opencode-ai/core/database/database"
import { writeSessionStore } from "@opencode-ai/core/atree/session-store"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionStore } from "@opencode-ai/core/session/store"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { testEffect } from "./lib/effect"
import { tmpdir } from "./fixture/tmpdir"
import { mkdir, writeFile } from "fs/promises"

const sessionID = SessionV2.ID.make("ses_tool_output_store")

const withStore = <A, E, R>(
  body: (input: { root: string; store: ToolOutputStore.Interface; fs: FSUtil.Interface }) => Effect.Effect<A, E, R>,
  config?: Config.Info,
) =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => {
      const global = Global.layerWith({ data: tmp.path })
      const configured = config
        ? Layer.succeed(
            Config.Service,
            Config.Service.of({
              entries: () => Effect.succeed([new Config.Document({ type: "document", info: config })]),
            }),
          )
        : Layer.empty
      const store = ToolOutputStore.layer.pipe(
        Layer.provide(FSUtil.defaultLayer),
        Layer.provide(global),
        Layer.provide(configured),
      )
      return Effect.gen(function* () {
        return yield* body({ root: tmp.path, store: yield* ToolOutputStore.Service, fs: yield* FSUtil.Service })
      }).pipe(Effect.provide(Layer.mergeAll(store, FSUtil.defaultLayer)))
    },
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )

const it = testEffect(Layer.empty)

describe("ToolOutputStore", () => {
  it.live("bounds the provider-facing text channel with one managed file", () =>
    withStore(({ store, fs }) =>
      Effect.gen(function* () {
        const first = "HEAD-" + "x".repeat(30_000)
        const second = "y".repeat(30_000) + "-TAIL"
        const result = yield* store.bound({
          sessionID,
          toolCallID: "call-aggregate",
          output: {
            structured: { kind: "report" },
            content: [
              { type: "text", text: first },
              { type: "text", text: second },
            ],
          },
        })
        expect(result.output.structured).toEqual({ kind: "report" })
        expect(result.outputPaths).toHaveLength(1)
        expect(yield* fs.readFileString(result.outputPaths[0])).toBe(first + second)
        if (result.output.content[0]?.type !== "text") throw new Error("expected text preview")
        expect(Buffer.byteLength(result.output.content[0].text)).toBeLessThanOrEqual(ToolOutputStore.MAX_BYTES)
      }),
    ),
  )

  it.live("uses bounded text for oversized structured-only output", () =>
    withStore(({ store, fs }) =>
      Effect.gen(function* () {
        const structured = { text: "x".repeat(ToolOutputStore.MAX_BYTES) }
        const result = yield* store.bound({ sessionID, toolCallID: "call-json", output: { structured, content: [] } })
        expect(result.output.structured).toEqual(structured)
        expect(result.outputPaths).toHaveLength(1)
        expect(JSON.parse(yield* fs.readFileString(result.outputPaths[0]))).toEqual(structured)
        expect(result.output.content).toHaveLength(1)
      }),
    ),
  )

  it.live("stores oversized output inside a file-backed session assets directory", () =>
    Effect.acquireUseRelease(
      Effect.all({
        data: Effect.promise(() => tmpdir()),
        directory: Effect.promise(() => tmpdir()),
      }),
      ({ data, directory }) =>
        Effect.gen(function* () {
          const info = {
            id: sessionID,
            projectID: Project.ID.global,
            title: "Tool output",
            location: { directory: AbsolutePath.make(directory.path) },
            time: { created: DateTime.makeUnsafe(1), updated: DateTime.makeUnsafe(1) },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          }
          yield* Effect.promise(() => writeSessionStore(info))

          const sessions = Layer.succeed(
            SessionStore.Service,
            SessionStore.Service.of({
              get: () => Effect.succeed(info),
              context: () => Effect.succeed([]),
              runnerEntries: () => Effect.succeed([]),
              runnerContext: () => Effect.succeed([]),
              message: () => Effect.succeed(undefined),
            }),
          )
          const storeLayer = ToolOutputStore.layer.pipe(
            Layer.provide(FSUtil.defaultLayer),
            Layer.provide(Global.layerWith({ data: data.path })),
            Layer.provide(sessions),
          )
          const result = yield* Effect.gen(function* () {
            const store = yield* ToolOutputStore.Service
            return yield* store.bound({
              sessionID,
              toolCallID: "call-session-assets",
              output: { structured: {}, content: [{ type: "text", text: "x".repeat(ToolOutputStore.MAX_BYTES + 1) }] },
            })
          }).pipe(Effect.provide(storeLayer))

          expect(result.outputPaths).toHaveLength(1)
          const outputPath = result.outputPaths[0]
          expect(outputPath).toContain(
            path.join(directory.path, ".agents", "atree", "sessions", sessionID, "assets", "tool-output"),
          )
          expect(yield* Effect.promise(() => Bun.file(outputPath).text())).toBe("x".repeat(ToolOutputStore.MAX_BYTES + 1))
          expect(yield* Effect.promise(() => Bun.file(path.join(data.path, "tool-output")).exists())).toBe(false)
        }),
      ({ data, directory }) =>
        Effect.all([
          Effect.promise(() => data[Symbol.asyncDispose]()),
          Effect.promise(() => directory[Symbol.asyncDispose]()),
        ]).pipe(Effect.ignore),
    ),
  )

  it.live("stores oversized output in the persisted file-backed session when SQLite points at a stale directory", () =>
    Effect.acquireUseRelease(
      Effect.all({
        data: Effect.promise(() => tmpdir()),
        root: Effect.promise(() => tmpdir()),
      }),
      ({ data, root }) =>
        Effect.gen(function* () {
          const staleDirectory = path.join(root.path, "old")
          const actualDirectory = path.join(root.path, "new")
          const previousData = Global.Path.data
          ;(Global.Path as { data: string }).data = data.path
          yield* Effect.addFinalizer(() => Effect.sync(() => ((Global.Path as { data: string }).data = previousData)))

          yield* Effect.promise(() => mkdir(path.join(data.path, "atree"), { recursive: true }))
          yield* Effect.promise(() =>
            writeFile(
              path.join(data.path, "atree", "state.json"),
              JSON.stringify({ version: 1, rootDirectory: root.path, updatedAt: 1 }),
            ),
          )
          yield* Effect.promise(() => mkdir(staleDirectory, { recursive: true }))
          yield* Effect.promise(() => mkdir(actualDirectory, { recursive: true }))

          const actual = {
            id: sessionID,
            projectID: Project.ID.global,
            title: "Actual tool output",
            location: { directory: AbsolutePath.make(actualDirectory) },
            time: { created: DateTime.makeUnsafe(1), updated: DateTime.makeUnsafe(2) },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          }
          yield* Effect.promise(() => writeSessionStore(actual))

          const database = Database.layerFromPath(":memory:")
          const sessions = SessionStore.layer.pipe(Layer.provide(database))
          const storeLayer = ToolOutputStore.layer.pipe(
            Layer.provide(FSUtil.defaultLayer),
            Layer.provide(Global.layerWith({ data: data.path })),
            Layer.provide(sessions),
          )
          const result = yield* Effect.gen(function* () {
            const { db } = yield* Database.Service
            yield* db
              .insert(ProjectTable)
              .values({
                id: Project.ID.global,
                worktree: staleDirectory,
                vcs: null,
                name: null,
                time_created: 1,
                time_updated: 1,
                sandboxes: [],
              } as unknown as typeof ProjectTable.$inferInsert)
              .onConflictDoNothing()
              .run()
              .pipe(Effect.orDie)
            yield* db
              .insert(SessionTable)
              .values({
                id: sessionID,
                project_id: Project.ID.global,
                slug: "stale-tool-output",
                directory: staleDirectory,
                title: "Stale tool output",
                version: "test",
                cost: 0,
                tokens_input: 0,
                tokens_output: 0,
                tokens_reasoning: 0,
                tokens_cache_read: 0,
                tokens_cache_write: 0,
                time_created: 1,
                time_updated: 1,
              } as typeof SessionTable.$inferInsert)
              .run()
              .pipe(Effect.orDie)

            const store = yield* ToolOutputStore.Service
            return yield* store.bound({
              sessionID,
              toolCallID: "call-stale-directory-session-assets",
              output: { structured: {}, content: [{ type: "text", text: "y".repeat(ToolOutputStore.MAX_BYTES + 1) }] },
            })
          }).pipe(Effect.provide(Layer.mergeAll(database, storeLayer)))

          expect(result.outputPaths).toHaveLength(1)
          expect(result.outputPaths[0]).toContain(
            path.join(actualDirectory, ".agents", "atree", "sessions", sessionID, "assets", "tool-output"),
          )
          expect(result.outputPaths[0]).not.toContain(staleDirectory)
        }),
      ({ data, root }) =>
        Effect.all([
          Effect.promise(() => data[Symbol.asyncDispose]()),
          Effect.promise(() => root[Symbol.asyncDispose]()),
        ]).pipe(Effect.ignore),
    ),
  )

  it.live("preserves native media and structured metadata without applying a settlement media limit", () =>
    withStore(({ store }) =>
      Effect.gen(function* () {
        const data = "a".repeat(6 * 1024 * 1024)
        const result = yield* store.bound({
          sessionID,
          toolCallID: "call-file",
          output: {
            structured: { caption: "pixel" },
            content: [{ type: "file", uri: `data:image/png;base64,${data}`, mime: "image/png", name: "pixel.png" }],
          },
        })
        expect(result.outputPaths).toEqual([])
        expect(result.output.structured).toEqual({ caption: "pixel" })
        expect(result.output.content).toHaveLength(1)
        expect(result.output.content[0]).toEqual({
          type: "file",
          uri: `data:image/png;base64,${data}`,
          mime: "image/png",
          name: "pixel.png",
        })
      }),
    ),
  )

  it.live("preserves structured metadata and native media when bounding text", () =>
    withStore(({ store, fs }) =>
      Effect.gen(function* () {
        const text = "x".repeat(ToolOutputStore.MAX_BYTES + 1)
        const media = {
          type: "file" as const,
          uri: "data:image/png;base64,aGVsbG8=",
          mime: "image/png",
          name: "pixel.png",
        }
        const result = yield* store.bound({
          sessionID,
          toolCallID: "call-text-and-media",
          output: { structured: { caption: "pixel" }, content: [{ type: "text", text }, media] },
        })

        expect(result.output.structured).toEqual({ caption: "pixel" })
        expect(result.output.content[1]).toEqual(media)
        expect(yield* fs.readFileString(result.outputPaths[0])).toBe(text)
      }),
    ),
  )

  it.live("does not double-count structured data duplicated in projected text", () =>
    withStore(({ store }) =>
      Effect.gen(function* () {
        const text = "x".repeat(30_000)
        const output = { structured: { output: text }, content: [{ type: "text" as const, text }] }
        expect(yield* store.bound({ sessionID, toolCallID: "call-duplicated", output })).toEqual({
          output,
          outputPaths: [],
        })
      }),
    ),
  )

  it.live("fails oversized settlement when complete retention cannot be written", () =>
    withStore(({ root, store, fs }) =>
      Effect.gen(function* () {
        yield* fs.writeFileString(path.join(root, "tool-output"), "not a directory")
        const exit = yield* store
          .bound({
            sessionID,
            toolCallID: "call-lossy",
            output: { structured: {}, content: [{ type: "text", text: "x".repeat(ToolOutputStore.MAX_BYTES + 1) }] },
          })
          .pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit))
          expect(Option.getOrUndefined(Cause.findErrorOption(exit.cause))?._tag).toBe("ToolOutputStore.StorageError")
      }),
    ),
  )

  it.live("does not encode ignored structured metadata when projected content exists", () =>
    withStore(({ store }) =>
      Effect.gen(function* () {
        const output = { structured: { value: 1n }, content: [{ type: "text" as const, text: "readable text" }] }
        expect(yield* store.bound({ sessionID, toolCallID: "call-unencodable", output })).toEqual({
          output,
          outputPaths: [],
        })
      }),
    ),
  )

  it.live("preserves interruption while retaining complete output", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => tmpdir())
      const blockedFilesystem = Layer.effect(
        FSUtil.Service,
        Effect.gen(function* () {
          const fs = yield* FSUtil.Service
          return FSUtil.Service.of({
            ...fs,
            ensureDir: () => Effect.void,
            writeFileString: () => Effect.never,
          })
        }),
      ).pipe(Layer.provide(FSUtil.defaultLayer))
      const store = ToolOutputStore.layer.pipe(
        Layer.provide(blockedFilesystem),
        Layer.provide(Global.layerWith({ data: root.path })),
      )
      const exit = yield* Effect.gen(function* () {
        const service = yield* ToolOutputStore.Service
        const fiber = yield* service
          .bound({
            sessionID,
            toolCallID: "call-interrupted",
            output: { structured: {}, content: [{ type: "text", text: "x".repeat(ToolOutputStore.MAX_BYTES + 1) }] },
          })
          .pipe(Effect.forkChild)
        yield* Fiber.interrupt(fiber)
        return yield* Fiber.await(fiber)
      }).pipe(Effect.provide(store))
      expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
      yield* Effect.promise(() => root[Symbol.asyncDispose]())
    }),
  )

  it.live("honors configured limits", () =>
    withStore(
      ({ store }) =>
        Effect.gen(function* () {
          expect(yield* store.limits()).toEqual({ maxLines: 2, maxBytes: 1_000 })
          const result = yield* store.bound({
            sessionID,
            toolCallID: "call-config",
            output: { structured: {}, content: [{ type: "text", text: "one\ntwo\nthree" }] },
          })
          expect(result.outputPaths).toHaveLength(1)
        }),
      new Config.Info({ tool_output: new ConfigToolOutput.Info({ max_lines: 2, max_bytes: 1_000 }) }),
    ),
  )

  it.live("cleans expired managed files and preserves unrelated files", () =>
    withStore(({ root, store, fs }) =>
      Effect.gen(function* () {
        const old = path.join(root, "tool-output", "tool_old")
        const recent = path.join(root, "tool-output", "tool_recent")
        const unrelated = path.join(root, "tool-output", "keep.txt")
        yield* fs.ensureDir(path.join(root, "tool-output"))
        yield* fs.writeFileString(old, "old")
        yield* fs.writeFileString(recent, "recent")
        yield* fs.writeFileString(unrelated, "keep")
        const expired = new Date(Date.now() - 8 * 24 * 60 * 60 * 1_000)
        yield* fs.utimes(old, expired, expired)
        yield* store.cleanup()
        expect(yield* fs.exists(old)).toBe(false)
        expect(yield* fs.exists(recent)).toBe(true)
        expect(yield* fs.exists(unrelated)).toBe(true)
      }),
    ),
  )
})
