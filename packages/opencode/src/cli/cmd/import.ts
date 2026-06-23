import type { Session as SDKSession, Message, Part } from "@opencode-ai/sdk/v2"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Session } from "@/session/session"
import { MessageV2 } from "../../session/message-v2"
import { effectCmd } from "../effect-cmd"
import { Database } from "@opencode-ai/core/database/database"
import { SessionTable, MessageTable, PartTable } from "@opencode-ai/core/session/sql"
import { InstanceRef } from "@/effect/instance-ref"
import { appendSessionJsonl, writeSessionStore } from "@/atree/session-store"
import { EOL } from "os"
import path from "path"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Effect, Schema } from "effect"
import type { InstanceContext } from "@/project/instance-context"
import type { Snapshot } from "@/snapshot"

const decodeMessageInfo = Schema.decodeUnknownSync(SessionV1.Info)
const decodePart = Schema.decodeUnknownSync(SessionV1.Part)

type ExportData = {
  info: SDKSession
  messages: Array<{ info: Message; parts: Part[] }>
  sessionDiff?: Snapshot.FileDiff[]
}

function diffSummary(diffs: Snapshot.FileDiff[] | undefined): Session.Info["summary"] | undefined {
  if (!diffs) return
  return {
    additions: diffs.reduce((sum, item) => sum + item.additions, 0),
    deletions: diffs.reduce((sum, item) => sum + item.deletions, 0),
    files: diffs.length,
    diffs,
  }
}

export const persistImportedSession = Effect.fn("Cli.import.persist")(function* (
  exportData: ExportData,
  ctx: Pick<InstanceContext, "project" | "directory" | "worktree">,
) {
  const { db } = yield* Database.Service
  const summary = exportData.info.summary ?? diffSummary(exportData.sessionDiff)
  const info = Schema.decodeUnknownSync(Session.Info)({
    ...exportData.info,
    projectID: ctx.project.id,
    directory: ctx.directory,
    path: path.relative(path.resolve(ctx.worktree), ctx.directory).replaceAll("\\", "/"),
    ...(summary ? { summary } : {}),
  }) as Session.Info
  const row = Session.toRow(info)

  yield* Effect.promise(() => writeSessionStore(info))
  yield* Effect.promise(() => appendSessionJsonl(info, { type: "session.created", sessionID: info.id, info }))
  if (exportData.sessionDiff) {
    yield* Effect.promise(() =>
      appendSessionJsonl(info, { type: "session.diff", sessionID: info.id, diff: exportData.sessionDiff }),
    )
  }

  yield* db
    .insert(SessionTable)
    .values(row)
    .onConflictDoUpdate({
      target: SessionTable.id,
      set: { project_id: row.project_id, directory: row.directory, path: row.path },
    })
    .run()
    .pipe(Effect.catchCause(() => Effect.void))

  for (const msg of exportData.messages) {
    const msgInfo = decodeMessageInfo(msg.info) as SessionV1.Info
    yield* Effect.promise(() => appendSessionJsonl(info, { type: "message.updated", message: msgInfo }))
    const { id, sessionID: _, ...msgData } = msgInfo
    yield* db
      .insert(MessageTable)
      .values({
        id,
        session_id: row.id,
        time_created: msgInfo.time?.created ?? Date.now(),
        data: msgData as never,
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.catchCause(() => Effect.void))

    for (const part of msg.parts) {
      const partInfo = decodePart(part) as SessionV1.Part
      yield* Effect.promise(() => appendSessionJsonl(info, { type: "message.part.updated", part: partInfo }))
      const { id: partId, sessionID: _s, messageID, ...partData } = partInfo
      yield* db
        .insert(PartTable)
        .values({
          id: partId,
          message_id: messageID,
          session_id: row.id,
          data: partData,
        })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.catchCause(() => Effect.void))
    }
  }

  return info
})

export const ImportCommand = effectCmd({
  command: "import <file>",
  describe: "import session data from JSON file",
  builder: (yargs) =>
    yargs.positional("file", {
      describe: "path to JSON file",
      type: "string",
      demandOption: true,
    }),
  handler: Effect.fn("Cli.import")(function* (args) {
    const ctx = yield* InstanceRef
    if (!ctx) return yield* Effect.die("InstanceRef not provided")
    return yield* runImport(args.file, ctx)
  }),
})

const runImport = Effect.fn("Cli.import.body")(function* (file: string, ctx: InstanceContext) {
  const fs = yield* FSUtil.Service

  let exportData: ExportData | undefined

  const isUrl = file.startsWith("http://") || file.startsWith("https://")

  if (isUrl) {
    process.stdout.write("Importing sessions from URLs has been removed from atree")
    process.stdout.write(EOL)
    return
  } else {
    exportData = (yield* fs.readJson(file).pipe(Effect.orElseSucceed(() => undefined))) as
      | NonNullable<typeof exportData>
      | undefined
    if (!exportData) {
      process.stdout.write(`File not found: ${file}`)
      process.stdout.write(EOL)
      return
    }
  }

  if (!exportData) {
    process.stdout.write(`Failed to read session data`)
    process.stdout.write(EOL)
    return
  }

  yield* persistImportedSession(exportData, ctx)

  process.stdout.write(`Imported session: ${exportData.info.id}`)
  process.stdout.write(EOL)
})
