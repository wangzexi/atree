import { test, expect } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { eq } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { MessageTable, PartTable, SessionTable } from "@opencode-ai/core/session/sql"
import { ProjectV2 } from "@opencode-ai/core/project"
import { readSessionJsonlMessages, readSessionStore } from "@/atree/session-store"
import { persistImportedSession } from "../../src/cli/cmd/import"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(Database.defaultLayer))

it.effect("persists imported sessions into the directory-backed atree store", () =>
  Effect.gen(function* () {
    const directory = yield* Effect.acquireRelease(
      Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "atree-import-session-"))),
      (dir) => Effect.promise(() => fs.rm(dir, { recursive: true, force: true })).pipe(Effect.ignore),
    )
    const sessionID = "ses_import_filebacked" as any
    const messageID = "msg_import_user" as any
    const partID = "prt_import_text" as any

    const imported = yield* persistImportedSession(
      {
        info: {
          id: sessionID,
          slug: "imported",
          title: "Imported session",
          version: "test",
          time: { created: 10, updated: 20 },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        } as any,
        sessionDiff: [{ file: "imported.ts", additions: 3, deletions: 1, status: "modified", patch: "@@" }],
        messages: [
          {
            info: {
              id: messageID,
              sessionID,
              role: "user",
              time: { created: 30 },
              agent: "build",
              model: { providerID: "test", modelID: "test-model" },
            } as any,
                parts: [{ id: partID, sessionID, messageID, type: "text", text: "from imported export" } as any],
          },
        ],
      },
      {
        project: { id: ProjectV2.ID.global },
        directory,
        worktree: directory,
      } as any,
    )

    const stored = yield* Effect.promise(() => readSessionStore(directory, sessionID))
    expect(stored?.title).toBe("Imported session")
    expect(stored?.summary).toMatchObject({
      additions: 3,
      deletions: 1,
      files: 1,
      diffs: [{ file: "imported.ts", additions: 3, deletions: 1, status: "modified", patch: "@@" }],
    })

    const { db } = yield* Database.Service
    const sessionRow = yield* db
      .select({ id: SessionTable.id })
      .from(SessionTable)
      .where(eq(SessionTable.id, sessionID))
      .get()
      .pipe(Effect.orDie)
    const messageRows = yield* db
      .select({ id: MessageTable.id })
      .from(MessageTable)
      .where(eq(MessageTable.session_id, sessionID))
      .all()
      .pipe(Effect.orDie)
    const partRows = yield* db
      .select({ id: PartTable.id })
      .from(PartTable)
      .where(eq(PartTable.session_id, sessionID))
      .all()
      .pipe(Effect.orDie)
    expect(sessionRow).toBeUndefined()
    expect(messageRows).toEqual([])
    expect(partRows).toEqual([])

    const messages = yield* Effect.promise(() => readSessionJsonlMessages(imported))
    expect(messages).toHaveLength(1)
    expect(messages[0]?.info).toMatchObject({ id: messageID, role: "user" })
    expect(messages[0]?.parts[0]).toMatchObject({ id: partID, type: "text", text: "from imported export" })

    const raw = yield* Effect.promise(() =>
      fs.readFile(path.join(directory, ".agents", "atree", "sessions", sessionID, "session.jsonl"), "utf8"),
    )
    const eventTypes = raw
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).type)
    expect(eventTypes).toEqual(["session.created", "session.diff", "message.updated", "message.part.updated"])
  }),
)

it.effect("materializes imported file parts into the session assets directory", () =>
  Effect.gen(function* () {
    const directory = yield* Effect.acquireRelease(
      Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "atree-import-assets-"))),
      (dir) => Effect.promise(() => fs.rm(dir, { recursive: true, force: true })).pipe(Effect.ignore),
    )
    const sessionID = "ses_import_assets" as any
    const messageID = "msg_import_assets" as any
    const partID = "prt_import_asset" as any

    const imported = yield* persistImportedSession(
      {
        info: {
          id: sessionID,
          slug: "imported-assets",
          title: "Imported assets",
          version: "test",
          time: { created: 10, updated: 20 },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        } as any,
        messages: [
          {
            info: {
              id: messageID,
              sessionID,
              role: "user",
              time: { created: 30 },
              agent: "build",
              model: { providerID: "test", modelID: "test-model" },
            } as any,
            parts: [
              {
                id: partID,
                sessionID,
                messageID,
                type: "file",
                mime: "image/png",
                filename: "pixel.png",
                url: "data:image/png;base64,cGl4ZWw=",
              } as any,
            ],
          },
        ],
      },
      {
        project: { id: ProjectV2.ID.global },
        directory,
        worktree: directory,
      } as any,
    )

    const raw = yield* Effect.promise(() =>
      fs.readFile(path.join(directory, ".agents", "atree", "sessions", sessionID, "session.jsonl"), "utf8"),
    )
    expect(raw).not.toContain("data:image/png;base64")
    expect(raw).toContain("\"assets\"")

    const messages = yield* Effect.promise(() => readSessionJsonlMessages(imported))
    const filePart = messages[0]?.parts[0] as any
    expect(filePart).toMatchObject({
      id: partID,
      type: "file",
      mime: "image/png",
      filename: "pixel.png",
      url: "data:image/png;base64,cGl4ZWw=",
    })

    const files = yield* Effect.promise(() =>
      fs.readdir(path.join(directory, ".agents", "atree", "sessions", sessionID, "assets")),
    )
    expect(files).toHaveLength(1)
    expect(
      yield* Effect.promise(() =>
        fs.readFile(path.join(directory, ".agents", "atree", "sessions", sessionID, "assets", files[0]), "utf8"),
      ),
    ).toBe("pixel")
  }),
)
