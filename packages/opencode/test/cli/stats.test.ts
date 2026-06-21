import { expect } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { ProjectV2 } from "@opencode-ai/core/project"
import { Storage } from "@/storage/storage"
import { Session as SessionNs } from "@/session/session"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { BackgroundJob } from "@/background/job"
import { EventV2Bridge } from "@/event-v2-bridge"
import { aggregateSessionStats } from "@/cli/cmd/stats"
import { appendSessionJsonl, writeSessionStore } from "@/atree/session-store"
import { writeWorkspaceRoot } from "@/atree/state"
import { testEffect } from "../lib/effect"

const it = testEffect(
  Layer.mergeAll(
    Database.defaultLayer,
    SessionNs.layer.pipe(
      Layer.provide(Storage.defaultLayer),
      Layer.provide(Database.defaultLayer),
      Layer.provideMerge(EventV2Bridge.defaultLayer),
      Layer.provide(SessionProjector.defaultLayer),
      Layer.provide(RuntimeFlags.layer({ experimentalWorkspaces: false })),
      Layer.provide(BackgroundJob.defaultLayer),
    ),
  ),
)

it.effect("aggregates directory-backed sessions that are missing SQLite session rows", () =>
  Effect.gen(function* () {
    const directory = yield* Effect.acquireRelease(
      Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "atree-stats-session-"))),
      (dir) => Effect.promise(() => fs.rm(dir, { recursive: true, force: true })).pipe(Effect.ignore),
    )
    yield* Effect.promise(() => writeWorkspaceRoot(directory))

    const sessionID = "ses_stats_filebacked" as any
    const messageID = "msg_stats_user" as any
    const partID = "prt_stats_text" as any
    const projectID = ProjectV2.ID.make("atree_stats_filebacked_project")
    const session = {
      id: sessionID,
      slug: "stats-filebacked",
      projectID,
      directory,
      title: "Stats file-backed",
      version: "test",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 10, updated: 30 },
    } as SessionNs.Info

    yield* Effect.promise(() => writeSessionStore(session))
    yield* Effect.promise(() =>
      appendSessionJsonl(session, {
        type: "session.created",
        sessionID,
        info: session,
      }),
    )
    yield* Effect.promise(() =>
      appendSessionJsonl(session, {
        type: "message.updated",
        message: {
          id: messageID,
          sessionID,
          role: "user",
          time: { created: 20 },
          agent: "build",
          model: { providerID: "test", modelID: "test-model" },
        },
      }),
    )
    yield* Effect.promise(() =>
      appendSessionJsonl(session, {
        type: "message.part.updated",
        part: { id: partID, sessionID, messageID, type: "text", text: "count me" },
      }),
    )

    const stats = yield* aggregateSessionStats(undefined, "", {
      id: projectID,
      worktree: directory,
      vcs: undefined,
      sandboxes: [],
      time: { created: 1, updated: 1 },
    } as any)
    expect(stats.totalSessions).toBe(1)
    expect(stats.totalMessages).toBe(1)
  }),
)
