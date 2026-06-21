import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Agent } from "../../src/agent/agent"
import { Session } from "../../src/session/session"
import { MessageID, SessionID } from "../../src/session/schema"
import { Todo } from "../../src/session/todo"
import { TodoWriteTool } from "../../src/tool/todo"
import { Tool } from "../../src/tool/tool"
import { Truncate } from "../../src/tool/truncate"

const sessionID = "ses_tool_todo" as SessionID
const directory = "/tmp/atree-tool-todo"

function ctx(): Tool.Context {
  return {
    sessionID,
    directory,
    messageID: "msg_tool_todo" as MessageID,
    agent: "build",
    abort: new AbortController().signal,
    messages: [],
    metadata: () => Effect.void,
    ask: () => Effect.void,
  }
}

describe("todowrite tool", () => {
  test("passes the current session directory to todo update", async () => {
    const calls = {
      get: undefined as { id: SessionID; options?: { directory?: string } } | undefined,
      update: undefined as Parameters<Todo.Interface["update"]>[0] | undefined,
    }

    const layer = Layer.mergeAll(
      Layer.succeed(
        Todo.Service,
        Todo.Service.of({
          update: (input) => {
            calls.update = input
            return Effect.void
          },
          get: () => Effect.succeed([]),
        }),
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
              title: "Todo tool session",
              slug: "todo-tool-session",
              version: "test",
              projectID: "proj_tool_todo",
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
        const info = yield* TodoWriteTool
        const tool = yield* Tool.init(info)
        yield* tool.execute(
          {
            todos: [{ content: "keep directory-bound todo", status: "pending", priority: "high" }],
          },
          ctx(),
        )
      }).pipe(Effect.provide(layer)),
    )

    expect(calls.get).toEqual({ id: sessionID, options: { directory } })
    expect(calls.update).toEqual({
      sessionID,
      directory,
      todos: [{ content: "keep directory-bound todo", status: "pending", priority: "high" }],
    })
  })
})
