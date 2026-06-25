import { beforeEach, describe, expect } from "bun:test"
import path from "path"
import os from "os"
import { mkdtempSync } from "fs"
import { readFile } from "fs/promises"
import { Effect, Layer, Stream } from "effect"
import { AgentV2 } from "@opencode-ai/core/agent"
import { asc, eq } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { EventTable } from "@opencode-ai/core/event/sql"
import { Location } from "@opencode-ai/core/location"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Prompt } from "@opencode-ai/core/session/prompt"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionInput } from "@opencode-ai/core/session/input"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionStore } from "@opencode-ai/core/session/store"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { testEffect } from "./lib/effect"
import { tmpdir } from "./fixture/tmpdir"

const database = Database.layerFromPath(":memory:")
const events = EventV2.layer.pipe(Layer.provide(database))
const projects = Layer.succeed(
  ProjectV2.Service,
  ProjectV2.Service.of({
    resolve: (directory) => Effect.succeed({ id: ProjectV2.ID.global, directory }),
    directories: () => Effect.succeed([]),
    commit: () => Effect.void,
  }),
)
const projector = SessionProjector.layer.pipe(Layer.provide(events), Layer.provide(database))
const store = SessionStore.layer.pipe(Layer.provide(database))
const sessions = SessionV2.layer.pipe(
  Layer.provide(events),
  Layer.provide(database),
  Layer.provide(store),
  Layer.provide(projects),
  Layer.provide(SessionExecution.noopLayer),
)
const it = testEffect(
  Layer.mergeAll(database, events, projects, projector, store, SessionExecution.noopLayer, sessions),
)
let location = Location.Ref.make({ directory: AbsolutePath.make(mkdtempSync(path.join(os.tmpdir(), "atree-session-create-"))) })

describe("SessionV2.create", () => {
  beforeEach(() => {
    location = Location.Ref.make({
      directory: AbsolutePath.make(mkdtempSync(path.join(os.tmpdir(), "atree-session-create-"))),
    })
  })

  it.effect("derives stable namespaced external IDs", () =>
    Effect.sync(() => {
      const input = { namespace: "opencord.agent-thread", key: "thread-1" }

      expect(SessionV2.ID.fromExternal(input)).toBe(SessionV2.ID.fromExternal(input))
      expect(SessionV2.ID.fromExternal(input)).toMatch(/^ses_[a-f0-9]{64}$/)
      expect(SessionV2.ID.fromExternal({ ...input, namespace: "another-app" })).not.toBe(
        SessionV2.ID.fromExternal(input),
      )
      expect(SessionV2.ID.fromExternal({ namespace: "a:b", key: "c" })).not.toBe(
        SessionV2.ID.fromExternal({ namespace: "a", key: "b:c" }),
      )
    }),
  )

  it.effect("creates a fresh projected session when the ID is omitted", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service

      const first = yield* session.create({ location })
      const second = yield* session.create({ location })

      expect(second.id).not.toBe(first.id)
      expect(yield* session.list({ directory: location.directory })).toHaveLength(2)
    }),
  )

  it.effect("returns the original session when the ID is retried", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const id = SessionV2.ID.create()
      const input = { id, location }

      const first = yield* session.create(input)
      const retried = yield* session.create(input)

      expect(retried).toEqual(first)
      expect(yield* session.list({ directory: location.directory })).toEqual([first])
    }),
  )

  it.effect("stores supplied immutable create attributes", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const workspaceID = WorkspaceV2.ID.make("wrk_test")
      const model = ModelV2.Ref.make({
        id: ModelV2.ID.make("sonnet"),
        providerID: ProviderV2.ID.anthropic,
        variant: ModelV2.VariantID.make("fast"),
      })

      expect(
        yield* session.create({
          location: Location.Ref.make({ directory: location.directory, workspaceID }),
          agent: AgentV2.ID.make("build"),
          model,
        }),
      ).toMatchObject({ location: { directory: location.directory, workspaceID }, agent: "build", model })
    }),
  )

  it.effect("returns the existing Session when one ID is reused with different create arguments", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const id = SessionV2.ID.create()
      const created = yield* session.create({ id, location })
      const changed = [
        { id, location, agent: AgentV2.ID.make("build") },
        {
          id,
          location,
          model: ModelV2.Ref.make({ id: ModelV2.ID.make("sonnet"), providerID: ProviderV2.ID.anthropic }),
        },
      ]

      for (const input of changed) {
        expect(yield* session.create(input)).toEqual(created)
      }
      expect(yield* session.list({ directory: location.directory })).toHaveLength(1)
    }),
  )

  it.effect("returns one recorded session to concurrent exact retries", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const id = SessionV2.ID.create()
      const input = { id, location }

      const created = yield* Effect.all([session.create(input), session.create(input)], { concurrency: "unbounded" })

      expect(created[1]).toEqual(created[0])
      expect(yield* session.list({ directory: location.directory })).toMatchObject([{ id: created[0].id }])
    }),
  )

  it.effect("does not treat direct SQLite updates as directory session data", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const { db } = yield* Database.Service
      const id = SessionV2.ID.create()
      const input = { id, location }
      const created = yield* session.create(input)

      yield* db.update(SessionTable).set({ agent: "build" }).where(eq(SessionTable.id, id)).run().pipe(Effect.orDie)

      expect(yield* session.create(input)).toMatchObject({ id: created.id, agent: undefined })
    }),
  )

  it.effect("does not treat legacy projected updates as directory session data", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const id = SessionV2.ID.create()
      const input = { id, location }
      const created = yield* session.create(input)
      const workspaceID = WorkspaceV2.ID.make("wrk_test")

      yield* events.publish(SessionV1.Event.Updated, {
        sessionID: id,
        info: SessionV1.SessionInfo.make({
          id,
          slug: "updated",
          version: "test",
          projectID: created.projectID,
          directory: created.location.directory,
          title: "updated",
          agent: "build",
          metadata: { icon: "🧭" },
          permission: [{ permission: "bash", pattern: "*", action: "allow" }],
          time: { created: 0, updated: 1 },
          summary: { additions: 1, deletions: 2, files: 3, diffs: [] },
          revert: { messageID: "msg_revert" as any },
          workspaceID,
          cost: 99,
          tokens: { input: 1, output: 2, reasoning: 3, cache: { read: 4, write: 5 } },
        }),
      })

      const row = yield* db.select().from(SessionTable).where(eq(SessionTable.id, id)).get().pipe(Effect.orDie)
      expect(row?.title).toBe("updated")
      expect(row?.agent).toBe("build")
      expect(row?.workspace_id).toBe(workspaceID)
      expect(row?.metadata).toBeNull()
      expect(row?.permission).toBeNull()
      expect(row?.summary_additions).toBeNull()
      expect(row?.summary_deletions).toBeNull()
      expect(row?.summary_files).toBeNull()
      expect(row?.summary_diffs).toBeNull()
      expect(row?.revert).toBeNull()

      expect(yield* session.create(input)).toMatchObject({ id, agent: undefined })
    }),
  )

  it.effect("persists creation through the existing legacy created event", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const { db } = yield* Database.Service
      const created = yield* session.create({ location })

      expect(
        yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, created.id)).all().pipe(Effect.orDie),
      ).toMatchObject([{ type: EventV2.versionedType(SessionV1.Event.Created.type, 1) }])
    }),
  )

  it.effect("persists caller-ID creation through the existing created event", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const { db } = yield* Database.Service
      const id = SessionV2.ID.create()
      const created = yield* session.create({ id, location })

      expect(
        yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, created.id)).get().pipe(Effect.orDie),
      ).toMatchObject({
        data: { sessionID: id },
      })
    }),
  )

  it.effect("omits legacy creation rows from the V2 Session event stream", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const created = yield* session.create({ location })
      yield* session.prompt({
        sessionID: created.id,
        prompt: new Prompt({ text: "Hello" }),
        resume: false,
        directory: location.directory,
      })
      yield* SessionInput.promoteSteers(db, events, created.id, Number.MAX_SAFE_INTEGER)

      expect(
        Array.from(
          yield* session.events({ sessionID: created.id, directory: location.directory }).pipe(Stream.take(1), Stream.runCollect),
        ),
      ).toMatchObject([
        { cursor: 2, event: { type: "session.next.prompt.admitted", data: { prompt: { text: "Hello" } } } },
      ])
    }),
  )

  it.effect("replays one prompt lifecycle into a fresh target database", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const sourceEvents = yield* EventV2.Service
      const sourceDb = (yield* Database.Service).db
      const created = yield* session.create({ id: SessionV2.ID.make("ses_fresh_target_replay"), location })
      const admitted = yield* session.prompt({
        sessionID: created.id,
        prompt: new Prompt({ text: "Replay lifecycle" }),
        resume: false,
        directory: location.directory,
      })
      yield* SessionInput.promoteSteers(sourceDb, sourceEvents, created.id, Number.MAX_SAFE_INTEGER)
      const serialized = (yield* sourceDb
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, created.id))
        .orderBy(asc(EventTable.seq))
        .all()
        .pipe(Effect.orDie)).map((event) => ({
        id: event.id,
        aggregateID: event.aggregate_id,
        seq: event.seq,
        type: event.type,
        data: event.data,
      }))

      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      const targetDatabase = Database.layerFromPath(path.join(tmp.path, "target.sqlite"))
      const targetEvents = EventV2.layer.pipe(Layer.provide(targetDatabase))
      const targetProjector = SessionProjector.layer.pipe(Layer.provide(targetEvents), Layer.provide(targetDatabase))
      const targetStore = SessionStore.layer.pipe(Layer.provide(targetDatabase))

      yield* Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const events = yield* EventV2.Service
        const store = yield* SessionStore.Service
        yield* db
          .insert(ProjectTable)
          .values({ id: ProjectV2.ID.global, worktree: location.directory, sandboxes: [] })
          .run()
          .pipe(Effect.orDie)

        expect(yield* store.get(created.id)).toBeUndefined()
        expect(yield* events.replayAll(serialized.slice(0, 2))).toBe(created.id)
        expect(yield* SessionInput.find(db, admitted.id)).toBeUndefined()
        expect(yield* store.context(created.id)).toEqual([])

        expect(yield* events.replayAll(serialized.slice(2))).toBeUndefined()
        expect(yield* SessionInput.find(db, admitted.id)).toBeUndefined()
        expect(yield* store.context(created.id)).toEqual([])
        expect(
          (yield* db
            .select()
            .from(EventTable)
            .where(eq(EventTable.aggregate_id, created.id))
            .orderBy(asc(EventTable.seq))
            .all()
            .pipe(Effect.orDie)).map((event) => [event.seq, event.type]),
        ).toEqual([
          [0, EventV2.versionedType(SessionV1.Event.Created.type, 1)],
        ])
      }).pipe(Effect.provide(Layer.fresh(Layer.mergeAll(targetDatabase, targetEvents, targetProjector, targetStore))))
    }),
  )

  it.effect("does not mask unrelated created projector defects", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const event = yield* EventV2.Service
      const id = SessionV2.ID.create()
      const defect = new Error("unrelated projector defect")
      yield* event.project(SessionV1.Event.Created, () => Effect.die(defect))

      expect(yield* session.create({ id, location }).pipe(Effect.catchDefect(Effect.succeed))).toBe(defect)
    }),
  )

  it.effect("records the file-backed created event before created projectors run", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const event = yield* EventV2.Service
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      const sessionID = SessionV2.ID.create()
      const defect = new Error("created projector failed after file write")
      yield* event.project(SessionV1.Event.Created, () => Effect.die(defect))

      expect(
        yield* session
          .create({
            id: sessionID,
            location: Location.Ref.make({ directory: AbsolutePath.make(tmp.path) }),
          })
          .pipe(Effect.catchDefect(Effect.succeed)),
      ).toBe(defect)

      const jsonl = yield* Effect.promise(() =>
        readFile(path.join(tmp.path, ".agents", "atree", "sessions", sessionID, "session.jsonl"), "utf8"),
      )
      expect(JSON.parse(jsonl.trim())).toMatchObject({
        type: "session.created",
        sessionID,
        info: { id: sessionID, location: { directory: tmp.path } },
      })
    }),
  )

  it.effect("reports unfinished Session operations as unavailable", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const created = yield* session.create({ location })
      const unavailable = (
        effect: Effect.Effect<void, SessionV2.NotFoundError | SessionV2.OperationUnavailableError>,
      ) =>
        effect.pipe(
          Effect.flip,
          Effect.map((error) => (error instanceof SessionV2.OperationUnavailableError ? error.operation : "not-found")),
        )

      expect(yield* unavailable(session.shell({ sessionID: created.id, command: "pwd" }))).toBe("shell")
      expect(yield* unavailable(session.skill({ sessionID: created.id, skill: "review" }))).toBe("skill")
      expect(yield* unavailable(session.switchAgent({ sessionID: created.id, agent: "build" }))).toBe("switchAgent")
    }),
  )

  it.effect("switches the selected model through the durable Session event", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const created = yield* session.create({ location })
      const model = ModelV2.Ref.make({
        id: ModelV2.ID.make("sonnet"),
        providerID: ProviderV2.ID.anthropic,
        variant: ModelV2.VariantID.make("high"),
      })

      yield* session.switchModel({ sessionID: created.id, model, directory: location.directory })

      expect(yield* session.get(created.id, { directory: location.directory })).toMatchObject({ model })
      expect(
        Array.from(
          yield* session.events({ sessionID: created.id, directory: location.directory }).pipe(Stream.take(1), Stream.runCollect),
        ),
      ).toMatchObject([{ event: { type: "session.next.model.switched", data: { model } } }])
    }),
  )

  it.effect("mirrors model switches into the file-backed session log", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      const location = Location.Ref.make({ directory: AbsolutePath.make(tmp.path) })
      const created = yield* session.create({ location })
      const model = ModelV2.Ref.make({
        id: ModelV2.ID.make("sonnet"),
        providerID: ProviderV2.ID.anthropic,
        variant: ModelV2.VariantID.make("high"),
      })

      yield* session.switchModel({ sessionID: created.id, model, directory: location.directory })

      expect(yield* session.get(created.id, { directory: location.directory })).toMatchObject({ model })
      const jsonl = yield* Effect.promise(() =>
        readFile(path.join(tmp.path, ".agents", "atree", "sessions", created.id, "session.jsonl"), "utf8"),
      )
      const entries = jsonl
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>)
      expect(entries.at(-1)).toMatchObject({
        type: "session.next.model.switched",
        sessionID: created.id,
        model,
      })
    }),
  )

  it.effect("persists repeated switches as distinct durable Session events", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const created = yield* session.create({ location })
      const model = ModelV2.Ref.make({ id: ModelV2.ID.make("sonnet"), providerID: ProviderV2.ID.anthropic })

      yield* session.switchModel({ sessionID: created.id, model, directory: location.directory })
      yield* session.switchModel({ sessionID: created.id, model, directory: location.directory })

      const jsonl = yield* Effect.promise(() =>
        readFile(path.join(location.directory, ".agents", "atree", "sessions", created.id, "session.jsonl"), "utf8"),
      )
      const entries = jsonl
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>)
      expect(entries.filter((entry) => entry.type === "session.next.model.switched")).toHaveLength(2)
      expect(yield* session.get(created.id, { directory: location.directory })).toMatchObject({ model })
    }),
  )

  it.effect("rejects a model switch for a missing Session", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const missing = SessionV2.ID.make("ses_missing_model_switch")

      expect(
        yield* session
          .switchModel({
            sessionID: missing,
            model: ModelV2.Ref.make({ id: ModelV2.ID.make("sonnet"), providerID: ProviderV2.ID.anthropic }),
          })
          .pipe(
            Effect.flip,
            Effect.map((error) => error._tag),
          ),
      ).toBe("Session.NotFoundError")
    }),
  )
})
