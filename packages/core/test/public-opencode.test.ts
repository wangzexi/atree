import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Schema, Stream } from "effect"
import { Global } from "@opencode-ai/core/global"
import { AbsolutePath, Location, Model, OpenCode, Session, Tool } from "@opencode-ai/core/public"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(OpenCode.layer)

describe("public native OpenCode API", () => {
  it.effect("exposes only the intentional Session capabilities", () =>
    Effect.gen(function* () {
      const opencode = yield* OpenCode.Service

      expect(Object.keys(opencode).sort()).toEqual(["sessions", "tools"])

      expect(Object.keys(opencode.sessions).sort()).toEqual([
        "context",
        "create",
        "events",
        "get",
        "interrupt",
        "list",
        "message",
        "messages",
        "prompt",
        "switchModel",
      ])
      expect(Session.ID.create()).toStartWith("ses_")
      expect(Session.MessageID.create()).toStartWith("msg_")
      yield* opencode.tools.register({
        public_tool: Tool.make({
          description: "Public tool",
          input: Schema.Struct({}),
          output: Schema.Struct({ ok: Schema.Boolean }),
          execute: () => Effect.succeed({ ok: true }),
        }),
      })
    }),
  )

  it.effect("switches to an available model and variant", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          yield* writeProvider(tmp.path)
          const opencode = yield* OpenCode.Service
          const sessionID = Session.ID.make("ses_public_switch_available")
          const model = ref({ variant: "fast" })
          yield* opencode.sessions.create({
            id: sessionID,
            location: Location.Ref.make({ directory: AbsolutePath.make(tmp.path) }),
          })

          yield* opencode.sessions.switchModel({ sessionID, model })

          expect((yield* opencode.sessions.get(sessionID)).model).toEqual(model)
        }),
      ),
    ),
  )

  it.effect("rejects missing and Location-disabled models without changing the Session", () =>
    Effect.acquireRelease(
      Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
      (dirs) => Effect.promise(() => Promise.all(dirs.map((dir) => dir[Symbol.asyncDispose]())).then(() => undefined)),
    ).pipe(
      Effect.flatMap(([available, disabled]) =>
        Effect.gen(function* () {
          yield* writeProvider(available.path)
          yield* writeProvider(disabled.path, true)
          const opencode = yield* OpenCode.Service
          const availableID = Session.ID.make("ses_public_switch_exact_available")
          const disabledID = Session.ID.make("ses_public_switch_exact_disabled")
          yield* opencode.sessions.create({
            id: availableID,
            location: Location.Ref.make({ directory: AbsolutePath.make(available.path) }),
          })
          yield* opencode.sessions.create({
            id: disabledID,
            location: Location.Ref.make({ directory: AbsolutePath.make(disabled.path) }),
          })

          yield* opencode.sessions.switchModel({ sessionID: availableID, model: ref({ variant: "default" }) })
          const disabledError = yield* opencode.sessions
            .switchModel({ sessionID: disabledID, model: ref() })
            .pipe(Effect.flip)
          const missingError = yield* opencode.sessions
            .switchModel({ sessionID: disabledID, model: ref({ id: "missing" }) })
            .pipe(Effect.flip)

          expect(disabledError).toBeInstanceOf(Session.ModelUnavailableError)
          expect(missingError).toBeInstanceOf(Session.ModelUnavailableError)
          expect((yield* opencode.sessions.get(availableID)).model).toEqual(ref({ variant: "default" }))
          expect((yield* opencode.sessions.get(disabledID)).model).toBeUndefined()
        }),
      ),
    ),
  )

  it.effect("rejects an unavailable variant without changing the Session", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          yield* writeProvider(tmp.path)
          const opencode = yield* OpenCode.Service
          const sessionID = Session.ID.make("ses_public_switch_variant")
          const selected = ref({ variant: "fast" })
          yield* opencode.sessions.create({
            id: sessionID,
            location: Location.Ref.make({ directory: AbsolutePath.make(tmp.path) }),
          })
          yield* opencode.sessions.switchModel({ sessionID, model: selected })

          const error = yield* opencode.sessions
            .switchModel({ sessionID, model: ref({ variant: "unknown" }) })
            .pipe(Effect.flip)

          expect(error).toBeInstanceOf(Session.VariantUnavailableError)
          expect((yield* opencode.sessions.get(sessionID)).model).toEqual(selected)
        }),
      ),
    ),
  )

  it.effect("preserves the typed not-found error for a missing Session", () =>
    Effect.gen(function* () {
      const opencode = yield* OpenCode.Service
      const sessionID = Session.ID.make("ses_public_switch_missing")
      const error = yield* opencode.sessions
        .switchModel({
          sessionID,
          model: Schema.decodeUnknownSync(Model.Ref)({ id: "claude-sonnet-4-5", providerID: "anthropic" }),
        })
        .pipe(Effect.flip)

      expect(error).toBeInstanceOf(Session.NotFoundError)
      if (error instanceof Session.NotFoundError) expect(error.sessionID).toBe(sessionID)
    }),
  )

  it.effect("routes file-backed sessions through the explicit directory", () =>
    Effect.acquireRelease(
      Effect.promise(() => Promise.all([tmpdir(), tmpdir(), tmpdir()])),
      (dirs) => Effect.promise(() => Promise.all(dirs.map((dir) => dir[Symbol.asyncDispose]())).then(() => undefined)),
    ).pipe(
      Effect.flatMap(([data, left, right]) =>
        Effect.gen(function* () {
          const previousData = Global.Path.data
          ;(Global.Path as { data: string }).data = data.path
          yield* Effect.addFinalizer(() => Effect.sync(() => ((Global.Path as { data: string }).data = previousData)))

          const opencode = yield* OpenCode.Service
          const sessionID = Session.ID.make("ses_public_directory_routed")
          const leftDirectory = AbsolutePath.make(left.path)
          const rightDirectory = AbsolutePath.make(right.path)
          yield* writeProvider(right.path)

          yield* Effect.promise(() =>
            writeAtreeSession({
              root: left.path,
              directory: left.path,
              sessionID,
              title: "Left session",
              text: "left message",
              timestamp: 10,
            }),
          )
          yield* Effect.promise(() =>
            writeAtreeSession({
              root: right.path,
              directory: right.path,
              sessionID,
              title: "Right session",
              text: "right message",
              timestamp: 20,
            }),
          )

          expect((yield* opencode.sessions.get(sessionID, { directory: leftDirectory })).title).toBe("Left session")
          expect((yield* opencode.sessions.get(sessionID, { directory: rightDirectory })).title).toBe("Right session")

          const leftMessages = yield* opencode.sessions.messages({
            sessionID,
            directory: leftDirectory,
            order: "asc",
          })
          const rightMessages = yield* opencode.sessions.context(sessionID, { directory: rightDirectory })
          expect(leftMessages).toMatchObject([{ type: "user", text: "left message" }])
          expect(rightMessages).toMatchObject([{ type: "user", text: "right message" }])

          expect(
            yield* opencode.sessions.message({
              sessionID,
              directory: leftDirectory,
              messageID: Session.MessageID.make("msg_public_directory_right"),
            }),
          ).toBeUndefined()

          const events = Array.from(
            yield* opencode.sessions.events({ sessionID, directory: rightDirectory }).pipe(Stream.runCollect),
          )
          expect(events).toHaveLength(1)
          const event = events[0]
          expect(event).toBeDefined()
          if (!event) return
          expect(event.event.type).toBe("session.next.prompt.admitted")
          expect(event.event.location?.directory).toBe(rightDirectory)

          const model = ref({ variant: "fast" })
          yield* opencode.sessions.switchModel({ sessionID, directory: rightDirectory, model })
          expect((yield* opencode.sessions.get(sessionID, { directory: rightDirectory })).model).toEqual(model)
          expect((yield* opencode.sessions.get(sessionID, { directory: leftDirectory })).model).toBeUndefined()
        }),
      ),
    ),
  )
})

const ref = (input: { id?: string; variant?: string } = {}) =>
  Schema.decodeUnknownSync(Model.Ref)({
    id: input.id ?? "chat",
    providerID: "public-test",
    variant: input.variant,
  })

const writeProvider = (directory: string, disabled = false) =>
  Effect.promise(() =>
    fs.writeFile(
      path.join(directory, "opencode.json"),
      JSON.stringify({
        providers: {
          "public-test": {
            name: "Public test",
            api: { type: "native", settings: {} },
            models: {
              chat: {
                disabled,
                variants: [{ id: "fast" }],
              },
            },
          },
        },
      }),
    ),
  )

async function writeAtreeSession(input: {
  root: string
  directory: string
  sessionID: Session.ID
  title: string
  text: string
  timestamp: number
}) {
  await fs.mkdir(path.join(Global.Path.data, "atree"), { recursive: true })
  await fs.writeFile(
    path.join(Global.Path.data, "atree", "state.json"),
    JSON.stringify({ version: 1, rootDirectory: input.root, updatedAt: 1 }),
  )
  const sessionRoot = path.join(input.directory, ".agents", "atree", "sessions", input.sessionID)
  await fs.mkdir(sessionRoot, { recursive: true })
  await fs.writeFile(
    path.join(sessionRoot, "meta.yaml"),
    [
      "version: 1",
      `id: ${JSON.stringify(input.sessionID)}`,
      `slug: ${JSON.stringify(input.sessionID)}`,
      `sessionVersion: "public-test"`,
      `projectID: "global"`,
      `workspaceID: null`,
      `path: "."`,
      `parentID: null`,
      `title: ${JSON.stringify(input.title)}`,
      `agent: null`,
      `model: null`,
      `createdAt: ${input.timestamp}`,
      `updatedAt: ${input.timestamp}`,
      `archivedAt: null`,
      `cost: 0`,
      `tokens: {"input":0,"output":0,"reasoning":0,"cache":{"read":0,"write":0}}`,
      `metadata: {}`,
      "",
    ].join("\n"),
  )
  const messageID = input.title.startsWith("Right")
    ? Session.MessageID.make("msg_public_directory_right")
    : Session.MessageID.make("msg_public_directory_left")
  await fs.writeFile(
    path.join(sessionRoot, "session.jsonl"),
    [
      JSON.stringify({
        version: 1,
        at: input.timestamp,
        type: "session.next.prompt.admitted",
        sessionID: input.sessionID,
        messageID,
        prompt: { text: input.text },
        delivery: "steer",
        timestamp: input.timestamp,
      }),
    ].join("\n") + "\n",
  )
}
