import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { NodePath } from "@effect/platform-node"
import { Cause, Duration, Effect, Layer, Option, Schedule, Context } from "effect"
import path from "path"
import type { Agent } from "../agent/agent"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { evaluate } from "@/permission"
import { Config } from "@/config/config"
import { Database } from "@opencode-ai/core/database/database"
import { Identifier } from "../id/id"
import { ToolID } from "./schema"
import { TRUNCATION_DIR } from "./truncation-dir"
import { InstanceState } from "@/effect/instance-state"
import { ensureSessionPayloadFilesByID, findSessionStore } from "@/atree/session-store"
import { resolveFileSession } from "@/atree/session-resolver"
import type { SessionID } from "@/session/schema"

const RETENTION = Duration.days(7)

export const MAX_LINES = 2000
export const MAX_BYTES = 50 * 1024
export const DIR = TRUNCATION_DIR
export const GLOB = path.join(TRUNCATION_DIR, "*")

export type Result = { content: string; truncated: false } | { content: string; truncated: true; outputPath?: string }

export interface Options {
  maxLines?: number
  maxBytes?: number
  direction?: "head" | "tail"
  sessionID?: SessionID
}

export interface WriteOptions {
  sessionID?: SessionID
}

function hasTaskTool(agent?: Agent.Info) {
  if (!agent?.permission) return false
  return evaluate("task", "*", agent.permission).action !== "deny"
}

export interface Interface {
  readonly cleanup: () => Effect.Effect<void>
  readonly write: (text: string, options?: WriteOptions) => Effect.Effect<string | undefined>
  /**
   * Returns output unchanged when it fits within the limits. If a file-backed
   * atree session is available, oversized output is saved under the session
   * assets directory; otherwise only the bounded preview is returned.
   */
  readonly output: (text: string, options?: Options, agent?: Agent.Info) => Effect.Effect<Result>
  /**
   * Resolved truncation limits: values from `tool_output` in opencode config, or MAX_LINES / MAX_BYTES if unset.
   */
  readonly limits: () => Effect.Effect<{ maxLines: number; maxBytes: number }>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Truncate") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service

    const directory = Effect.fn("Truncate.directory")(function* (options?: WriteOptions) {
      const sessionID = options?.sessionID
      if (!sessionID) return undefined
      const ctx = yield* InstanceState.context.pipe(Effect.catchCause(() => Effect.succeed(undefined)))
      const database = yield* Effect.serviceOption(Database.Service)
      const session = Option.isSome(database)
        ? yield* resolveFileSession({ sessionID, instanceDirectory: ctx?.directory }).pipe(
            Effect.catchCause(() => Effect.succeed(undefined)),
          )
        : ctx
          ? yield* Effect.promise(() => findSessionStore(ctx.directory, sessionID)).pipe(
              Effect.catchCause(() => Effect.succeed(undefined)),
            )
          : undefined
      if (!session) return undefined
      yield* Effect.promise(() => ensureSessionPayloadFilesByID(session.directory, sessionID)).pipe(
        Effect.catchCause(() => Effect.void),
      )
      return path.join(session.directory, ".agents", "atree", "sessions", sessionID, "assets", "tool-output")
    })

    const cleanup = Effect.fn("Truncate.cleanup")(function* () {
      const cutoff = Identifier.timestamp(
        Identifier.create("tool", "ascending", Date.now() - Duration.toMillis(RETENTION)),
      )
      const entries = yield* fs.readDirectory(TRUNCATION_DIR).pipe(
        Effect.map((all) => all.filter((name) => name.startsWith("tool_"))),
        Effect.catch(() => Effect.succeed([])),
      )
      for (const entry of entries) {
        if (Identifier.timestamp(entry) >= cutoff) continue
        yield* fs.remove(path.join(TRUNCATION_DIR, entry)).pipe(Effect.catch(() => Effect.void))
      }
    })

    const write = Effect.fn("Truncate.write")(function* (text: string, options?: WriteOptions) {
      const dir = yield* directory(options)
      if (!dir) return undefined
      const file = path.join(dir, ToolID.ascending())
      yield* fs.ensureDir(dir).pipe(Effect.orDie)
      yield* fs.writeFileString(file, text).pipe(Effect.orDie)
      return file
    })

    const limits = Effect.fn("Truncate.limits")(function* () {
      const configSvc = yield* Effect.serviceOption(Config.Service)
      if (Option.isNone(configSvc)) return { maxLines: MAX_LINES, maxBytes: MAX_BYTES }
      const cfg = yield* configSvc.value.get().pipe(Effect.catch(() => Effect.succeed(undefined)))
      return {
        maxLines: cfg?.tool_output?.max_lines ?? MAX_LINES,
        maxBytes: cfg?.tool_output?.max_bytes ?? MAX_BYTES,
      }
    })

    const output = Effect.fn("Truncate.output")(function* (text: string, options: Options = {}, agent?: Agent.Info) {
      const resolved = yield* limits()
      const maxLines = options.maxLines ?? resolved.maxLines
      const maxBytes = options.maxBytes ?? resolved.maxBytes
      const direction = options.direction ?? "head"
      const lines = text.split("\n")
      const totalBytes = Buffer.byteLength(text, "utf-8")

      if (lines.length <= maxLines && totalBytes <= maxBytes) {
        return { content: text, truncated: false } as const
      }

      const out: string[] = []
      let i = 0
      let bytes = 0
      let hitBytes = false

      if (direction === "head") {
        for (i = 0; i < lines.length && i < maxLines; i++) {
          const size = Buffer.byteLength(lines[i], "utf-8") + (i > 0 ? 1 : 0)
          if (bytes + size > maxBytes) {
            hitBytes = true
            break
          }
          out.push(lines[i])
          bytes += size
        }
      } else {
        for (i = lines.length - 1; i >= 0 && out.length < maxLines; i--) {
          const size = Buffer.byteLength(lines[i], "utf-8") + (out.length > 0 ? 1 : 0)
          if (bytes + size > maxBytes) {
            hitBytes = true
            break
          }
          out.unshift(lines[i])
          bytes += size
        }
      }

      const removed = hitBytes ? totalBytes - bytes : lines.length - out.length
      const unit = hitBytes ? "bytes" : "lines"
      const preview = out.join("\n")
      const file = yield* write(text, { sessionID: options.sessionID })

      const hint = file
        ? hasTaskTool(agent)
          ? `The tool call succeeded but the output was truncated. Full output saved to: ${file}\nUse the Task tool to have explore agent process this file with Grep and Read (with offset/limit). Do NOT read the full file yourself - delegate to save context.`
          : `The tool call succeeded but the output was truncated. Full output saved to: ${file}\nUse Grep to search the full content or Read with offset/limit to view specific sections.`
        : "The tool call succeeded but the output was truncated. No session asset store is available, so the full output was not retained."

      return {
        content:
          direction === "head"
            ? `${preview}\n\n...${removed} ${unit} truncated...\n\n${hint}`
            : `...${removed} ${unit} truncated...\n\n${hint}\n\n${preview}`,
        truncated: true,
        ...(file ? { outputPath: file } : {}),
      } as const
    })

    yield* cleanup().pipe(
      Effect.catchCause((cause) => Effect.logError("truncation cleanup failed", { cause: Cause.pretty(cause) })),
      Effect.repeat(Schedule.spaced(Duration.hours(1))),
      Effect.delay(Duration.minutes(1)),
      Effect.forkScoped,
    )

    return Service.of({ cleanup, write, output, limits })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(FSUtil.defaultLayer), Layer.provide(NodePath.layer))

export const node = LayerNode.make(layer, [FSUtil.node])

export * as Truncate from "./truncate"
