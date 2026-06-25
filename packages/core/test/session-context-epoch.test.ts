import { expect } from "bun:test"
import path from "path"
import { readFile } from "fs/promises"
import { Effect, DateTime, Layer, Schema } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { Location } from "@opencode-ai/core/location"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { AgentV2 } from "@opencode-ai/core/agent"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionContextEpoch } from "@opencode-ai/core/session/context-epoch"
import { SessionTable } from "@opencode-ai/core/session/sql"
import {
  appendSessionJsonl,
  readSessionPromptStates,
  readSessionPromptStatesByID,
  readSessionStore,
  writeSessionStore,
} from "@opencode-ai/core/atree/session-store"
import { SystemContext } from "@opencode-ai/core/system-context"
import { testEffect } from "./lib/effect"
import { tmpdir } from "./fixture/tmpdir"

const database = Database.layerFromPath(":memory:")
const eventLayer = EventV2.layer.pipe(Layer.provide(database))
const it = testEffect(Layer.mergeAll(database, eventLayer))

it.effect("mirrors context updates into file-backed session jsonl", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()).pipe(Effect.orDie),
    )
    const directory = AbsolutePath.make(tmp.path)
    const sessionID = SessionV2.ID.make("ses_context_epoch_jsonl")
    const agent = AgentV2.ID.make("build")
    const location = Location.Ref.make({ directory })
    const session = SessionV2.Info.make({
      id: sessionID,
      projectID: ProjectV2.ID.global,
      title: "Context epoch jsonl",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: DateTime.makeUnsafe(1), updated: DateTime.makeUnsafe(1) },
      location,
      agent,
    })
    yield* Effect.promise(() => writeSessionStore(session))
    const { db } = yield* Database.Service
    const events = yield* EventV2.Service
    yield* db
      .insert(ProjectTable)
      .values({ id: ProjectV2.ID.global, worktree: directory, sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: ProjectV2.ID.global,
        slug: sessionID,
        directory,
        title: "Context epoch jsonl",
        version: "core",
        agent,
      })
      .run()
      .pipe(Effect.orDie)

    let contextText = "Initial context"
    const context = () =>
      SystemContext.make({
        key: SystemContext.Key.make("test/context"),
        codec: Schema.String,
        load: Effect.sync(() => contextText),
        baseline: (value) => value,
        update: (_previous, current) => current,
      })

    yield* SessionContextEpoch.prepare(db, events, Effect.sync(context), sessionID, location, agent)
    contextText = "Changed context"
    yield* SessionContextEpoch.prepare(db, events, Effect.sync(context), sessionID, location, agent)

    const entries = (
      yield* Effect.promise(() =>
        readFile(path.join(tmp.path, ".agents", "atree", "sessions", sessionID, "session.jsonl"), "utf8"),
      )
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(entries.some((entry) => entry.type === "session.next.context.updated" && entry.text === "Changed context")).toBe(
      true,
    )
  }),
)

it.effect("prepares context epochs for file-backed sessions without SQLite rows", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()).pipe(Effect.orDie),
    )
    const directory = AbsolutePath.make(tmp.path)
    const sessionID = SessionV2.ID.make("ses_context_epoch_no_row")
    const agent = AgentV2.ID.make("build")
    const location = Location.Ref.make({ directory })
    const session = SessionV2.Info.make({
      id: sessionID,
      projectID: ProjectV2.ID.global,
      title: "Context epoch no row",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: DateTime.makeUnsafe(1), updated: DateTime.makeUnsafe(1) },
      location,
      agent,
    })
    yield* Effect.promise(() => writeSessionStore(session))
    yield* Effect.promise(() =>
      appendSessionJsonl(session, {
        type: "session.next.prompt.admitted",
        sessionID,
        messageID: "msg_context_epoch_file_prompt",
        timestamp: 10,
        prompt: { text: "file-backed prompt before context" },
        delivery: "steer",
      }),
    )
    const { db } = yield* Database.Service
    const events = yield* EventV2.Service
    expect((yield* Effect.promise(() => readSessionPromptStates(session))).size).toBe(1)
    const stored = yield* Effect.promise(() => readSessionStore(directory, sessionID))
    expect(stored).toBeDefined()
    expect(stored ? (yield* Effect.promise(() => readSessionPromptStates(stored))).size : 0).toBe(1)
    expect((yield* Effect.promise(() => readSessionPromptStatesByID(directory, sessionID))).size).toBe(1)

    let contextText = "Initial context"
    const context = () =>
      SystemContext.make({
        key: SystemContext.Key.make("test/context/no-row"),
        codec: Schema.String,
        load: Effect.sync(() => contextText),
        baseline: (value) => value,
        update: (_previous, current) => current,
      })

    const prepared = yield* SessionContextEpoch.prepare(db, events, Effect.sync(context), sessionID, location, agent)
    expect(prepared.revision).toBe(0)
    expect(prepared.baselineSeq).toBe(1)
    expect(
      yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie),
    ).toBeDefined()

    contextText = "Changed context"
    yield* SessionContextEpoch.prepare(db, events, Effect.sync(context), sessionID, location, agent)

    const entries = (
      yield* Effect.promise(() =>
        readFile(path.join(tmp.path, ".agents", "atree", "sessions", sessionID, "session.jsonl"), "utf8"),
      )
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(
      entries.some((entry) => entry.type === "session.next.context.updated" && entry.text === "Changed context"),
    ).toBe(true)
  }),
)

it.effect("rebuilds file-backed context epochs after deleting SQLite cache rows", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()).pipe(Effect.orDie),
    )
    const directory = AbsolutePath.make(tmp.path)
    const sessionID = SessionV2.ID.make("ses_context_epoch_deleted_cache")
    const agent = AgentV2.ID.make("build")
    const location = Location.Ref.make({ directory })
    const session = SessionV2.Info.make({
      id: sessionID,
      projectID: ProjectV2.ID.global,
      title: "Context epoch deleted cache",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: DateTime.makeUnsafe(1), updated: DateTime.makeUnsafe(1) },
      location,
      agent,
    })
    yield* Effect.promise(() => writeSessionStore(session))
    const { db } = yield* Database.Service
    const events = yield* EventV2.Service

    let contextText = "Initial context"
    const context = () =>
      SystemContext.make({
        key: SystemContext.Key.make("test/context/deleted-cache"),
        codec: Schema.String,
        load: Effect.sync(() => contextText),
        baseline: (value) => value,
        update: (_previous, current) => current,
      })

    const first = yield* SessionContextEpoch.prepare(db, events, Effect.sync(context), sessionID, location, agent)
    expect(first.revision).toBe(0)

    yield* db.delete(SessionTable).where(eq(SessionTable.id, sessionID)).run().pipe(Effect.orDie)
    expect(
      yield* db
        .select()
        .from(SessionTable)
        .where(eq(SessionTable.id, sessionID))
        .get()
        .pipe(Effect.orDie),
    ).toBeUndefined()

    contextText = "Changed context after cache delete"
    const second = yield* SessionContextEpoch.prepare(db, events, Effect.sync(context), sessionID, location, agent)
    expect(second.revision).toBe(0)
    expect(second.baseline).toBe("Changed context after cache delete")

    const rebuilt = yield* db
      .select()
      .from(SessionTable)
      .where(eq(SessionTable.id, sessionID))
      .get()
      .pipe(Effect.orDie)
    expect(rebuilt).toBeDefined()

    const stored = yield* Effect.promise(() => readSessionStore(directory, sessionID))
    expect(stored?.title).toBe("Context epoch deleted cache")

    const raw = yield* Effect.promise(() =>
      readFile(path.join(tmp.path, ".agents", "atree", "sessions", sessionID, "session.jsonl"), "utf8"),
    )
    const trimmed = raw.trim()
    const entries = trimmed
      ? trimmed.split("\n").map((line) => JSON.parse(line) as Record<string, unknown>)
      : []
    expect(entries.some((entry) => entry.type === "session.next.context.updated")).toBe(false)
  }),
)

it.effect("rebuilds only placement fields for file-backed context epochs", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()).pipe(Effect.orDie),
    )
    const directory = AbsolutePath.make(tmp.path)
    const sessionID = SessionV2.ID.make("ses_context_epoch_minimal_cache")
    const agent = AgentV2.ID.make("build")
    const location = Location.Ref.make({ directory })
    const archivedAt = DateTime.makeUnsafe(99)
    const session = SessionV2.Info.make({
      id: sessionID,
      projectID: ProjectV2.ID.global,
      title: "Context epoch minimal cache",
      cost: 42,
      tokens: { input: 7, output: 8, reasoning: 9, cache: { read: 10, write: 11 } },
      time: { created: DateTime.makeUnsafe(1), updated: DateTime.makeUnsafe(2), archived: archivedAt },
      location,
      agent,
    })
    yield* Effect.promise(() => writeSessionStore(session))
    const { db } = yield* Database.Service
    const events = yield* EventV2.Service

    const context = () =>
      SystemContext.make({
        key: SystemContext.Key.make("test/context/minimal-cache"),
        codec: Schema.String,
        load: Effect.sync(() => "Minimal cache"),
        baseline: (value) => value,
        update: (_previous, current) => current,
      })

    yield* SessionContextEpoch.prepare(db, events, Effect.sync(context), sessionID, location, agent)

    const cached = yield* db
      .select()
      .from(SessionTable)
      .where(eq(SessionTable.id, sessionID))
      .get()
      .pipe(Effect.orDie)
    expect(cached).toBeDefined()
    expect(cached?.directory).toBe(directory)
    expect(cached?.agent).toBe(agent)
    expect(cached?.title).toBe("Context epoch minimal cache")
    expect(cached?.cost).toBe(0)
    expect(cached?.tokens_input).toBe(0)
    expect(cached?.tokens_output).toBe(0)
    expect(cached?.tokens_reasoning).toBe(0)
    expect(cached?.tokens_cache_read).toBe(0)
    expect(cached?.tokens_cache_write).toBe(0)
    expect(cached?.time_archived).toBeNull()
    expect(cached?.path).toBeNull()
    expect(cached?.model).toBeNull()
  }),
)

it.effect("rebinds copied file-backed context epochs to the explicit directory instead of reusing another copy", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()).pipe(Effect.orDie),
    )
    const root = AbsolutePath.make(tmp.path)
    const source = AbsolutePath.make(path.join(tmp.path, "source"))
    const target = AbsolutePath.make(path.join(tmp.path, "target"))
    const sessionID = SessionV2.ID.make("ses_context_epoch_copied")
    const agent = AgentV2.ID.make("build")

    const writeSession = (directory: AbsolutePath, title: string) =>
      writeSessionStore(
        SessionV2.Info.make({
          id: sessionID,
          projectID: ProjectV2.ID.global,
          title,
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: DateTime.makeUnsafe(1), updated: DateTime.makeUnsafe(1) },
          location: Location.Ref.make({ directory }),
          agent,
        }),
      )

    yield* Effect.promise(() => writeSession(source, "Context epoch source"))
    yield* Effect.promise(() => writeSession(target, "Context epoch target"))

    const { db } = yield* Database.Service
    const events = yield* EventV2.Service
    yield* db
      .insert(ProjectTable)
      .values({ id: ProjectV2.ID.global, worktree: root, sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)

    let contextText = "Source baseline"
    const context = () =>
      SystemContext.make({
        key: SystemContext.Key.make("test/context/copied"),
        codec: Schema.String,
        load: Effect.sync(() => contextText),
        baseline: (value) => value,
        update: (_previous, current) => current,
      })

    const sourcePrepared = yield* SessionContextEpoch.prepare(
      db,
      events,
      Effect.sync(context),
      sessionID,
      Location.Ref.make({ directory: source }),
      agent,
    )
    expect(sourcePrepared.revision).toBe(0)
    expect(sourcePrepared.baseline).toBe("Source baseline")

    contextText = "Target baseline"
    const targetPrepared = yield* SessionContextEpoch.prepare(
      db,
      events,
      Effect.sync(context),
      sessionID,
      Location.Ref.make({ directory: target }),
      agent,
    )
    expect(targetPrepared.revision).toBe(0)
    expect(targetPrepared.baseline).toBe("Target baseline")

    const cached = yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie)
    expect(cached?.directory).toBe(target)

    const raw = yield* Effect.promise(() =>
      readFile(path.join(target, ".agents", "atree", "sessions", sessionID, "session.jsonl"), "utf8"),
    )
    const trimmed = raw.trim()
    const entries = trimmed
      ? trimmed.split("\n").map((line) => JSON.parse(line) as Record<string, unknown>)
      : []
    expect(entries.some((entry) => entry.type === "session.next.context.updated")).toBe(false)
  }),
)
