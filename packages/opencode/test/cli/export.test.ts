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
import { appendSessionJsonl, writeSessionStore } from "@/atree/session-store"
import { exportSessionData } from "@/cli/cmd/export"
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

it.effect("exports directory-backed sessions that are missing SQLite session rows", () =>
  Effect.gen(function* () {
    const directory = yield* Effect.acquireRelease(
      Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "atree-export-session-"))),
      (dir) => Effect.promise(() => fs.rm(dir, { recursive: true, force: true })).pipe(Effect.ignore),
    )
    const sessionID = "ses_export_filebacked" as never
    const messageID = "msg_export_user" as never
    const partID = "prt_export_text" as never
    const projectID = ProjectV2.ID.make("atree_export_filebacked_project")
    const session = {
      id: sessionID,
      slug: "export-filebacked",
      projectID,
      directory,
      title: "Export file-backed",
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
        part: { id: partID, sessionID, messageID, type: "text", text: "export me" },
      }),
    )
    yield* Effect.promise(() =>
      appendSessionJsonl(session, {
        type: "session.diff",
        sessionID,
        diff: [{ file: "changed.ts", additions: 2, deletions: 1, status: "modified", patch: "@@" }],
      }),
    )

    const exported = yield* exportSessionData({ sessionID, directory })

    expect(exported.info.id).toBe(sessionID)
    expect(exported.info.title).toBe("Export file-backed")
    expect(exported.messages).toHaveLength(1)
    expect(exported.messages[0]?.info).toMatchObject({ id: messageID, role: "user" })
    expect(exported.messages[0]?.parts[0]).toMatchObject({ id: partID, type: "text", text: "export me" })
    expect(exported.sessionDiff).toEqual([
      { file: "changed.ts", additions: 2, deletions: 1, status: "modified", patch: "@@" },
    ])
  }),
)
