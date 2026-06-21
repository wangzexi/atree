import { expect } from "bun:test"
import path from "path"
import { readFile } from "fs/promises"
import { Effect, DateTime, Layer, Schema } from "effect"
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
import { writeSessionStore } from "@opencode-ai/core/atree/session-store"
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
