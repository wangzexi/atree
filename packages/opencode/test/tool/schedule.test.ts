import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Agent } from "../../src/agent/agent"
import { Schedule } from "../../src/session/schedule"
import { Session } from "../../src/session/session"
import { MessageID, SessionID } from "../../src/session/schema"
import { ScheduleTool } from "../../src/tool/schedule"
import { Tool } from "../../src/tool/tool"
import { Truncate } from "../../src/tool/truncate"

const sessionID = "ses_tool_schedule" as SessionID
const directory = "/tmp/atree-tool-schedule"

function ctx(): Tool.Context {
  return {
    sessionID,
    directory,
    messageID: "msg_tool_schedule" as MessageID,
    agent: "build",
    abort: new AbortController().signal,
    messages: [],
    metadata: () => Effect.void,
    ask: () => Effect.void,
  }
}

describe("schedule tool", () => {
  test("passes the current session directory to schedule operations", async () => {
    const calls = {
      get: undefined as { id: SessionID; options?: { directory?: string } } | undefined,
      create: undefined as Parameters<Schedule.Interface["create"]>[0] | undefined,
      delete: undefined as { id: Schedule.ID; options?: { directory?: string } } | undefined,
      list: undefined as { sessionID: SessionID; options?: { directory?: string } } | undefined,
    }

    const layer = Layer.mergeAll(
      Layer.succeed(
        Schedule.Service,
        Schedule.Service.of({
          create: (input) => {
            calls.create = input
            return Effect.succeed({
              id: "sch_tool_schedule" as Schedule.ID,
              sessionID: input.sessionID,
              kind: input.kind ?? "recurring",
              expression: input.expression ?? "",
              runAt: input.runAt ?? null,
              message: input.message,
              createdAt: Date.now(),
              lastRanAt: null,
              lastRunStatus: null,
              nextRun: input.runAt ?? null,
            })
          },
          delete: (id, options) => {
            calls.delete = { id, options }
            return Effect.void
          },
          list: (id, options) => {
            calls.list = { sessionID: id, options }
            return Effect.succeed([])
          },
          tick: () => Effect.void,
          recordRun: () => Effect.void,
          clear: () => Effect.void,
          restoreDirectory: () => Effect.void,
        } satisfies Schedule.Interface),
      ),
      Layer.succeed(
        Session.Service,
        Session.Service.of({
          get: (id: SessionID, options?: { directory?: string }) =>
            Effect.sync(() => {
              calls.get = { id, options }
              return {
              id: sessionID,
              directory,
              title: "Schedule tool session",
              slug: "schedule-tool-session",
              version: "test",
              projectID: "proj_tool_schedule",
              cost: 0,
              time: { created: Date.now(), updated: Date.now() },
              } as any
            }),
        } as unknown as Session.Interface),
      ),
      Layer.succeed(
        Agent.Service,
        Agent.Service.of({
          get: () => Effect.succeed({ permission: {} } as any),
        } as unknown as Agent.Interface),
      ),
      Layer.succeed(
        Truncate.Service,
        Truncate.Service.of({
          cleanup: () => Effect.void,
          write: () => Effect.succeed(""),
          limits: () => Effect.succeed({ maxLines: 2000, maxBytes: 50 * 1024 }),
          output: (text) => Effect.succeed({ content: text, truncated: false }),
        }),
      ),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const info = yield* ScheduleTool
        const tool = yield* Tool.init(info)
        yield* tool.execute(
          {
            action: "create",
            type: "at",
            at: Date.now() + 60_000,
            message: "run from tool",
          },
          ctx(),
        )
        yield* tool.execute({ action: "list" }, ctx())
        yield* tool.execute({ action: "delete", id: "sch_tool_schedule" }, ctx())
      }).pipe(Effect.provide(layer)),
    )

    expect(calls.get).toEqual({ id: sessionID, options: { directory } })
    expect(calls.create).toMatchObject({ sessionID, directory, message: "run from tool" })
    expect(calls.list).toEqual({ sessionID, options: { directory } })
    expect(calls.delete).toEqual({ id: "sch_tool_schedule" as Schedule.ID, options: { directory } })
  })
})
