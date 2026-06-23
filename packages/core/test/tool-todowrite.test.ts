import { describe, expect } from "bun:test"
import { DateTime, Effect, Layer } from "effect"
import { readSessionTodoProjection } from "@opencode-ai/core/atree/todo-store"
import { writeSessionStore } from "@opencode-ai/core/atree/session-store"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionTodo } from "@opencode-ai/core/session/todo"
import { TodoWriteTool } from "@opencode-ai/core/tool/todowrite"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { testEffect } from "./lib/effect"
import { toolIdentity, executeTool, settleTool, toolDefinitions } from "./lib/tool"
import { tmpdir } from "./fixture/tmpdir"

const sessionID = SessionV2.ID.make("ses_todowrite_tool_test")
const assertions: PermissionV2.AssertInput[] = []
let deny = false

const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: (input) =>
      Effect.sync(() => assertions.push(input)).pipe(
        Effect.andThen(deny ? Effect.fail(new PermissionV2.DeniedError({ rules: [] })) : Effect.void),
      ),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)
const database = Database.layerFromPath(":memory:")
const events = EventV2.layer.pipe(Layer.provide(database))
const todos = SessionTodo.layer.pipe(Layer.provide(database), Layer.provide(events))
const registry = ToolRegistry.defaultLayer.pipe(Layer.provide(permission))
const tool = TodoWriteTool.layer.pipe(Layer.provide(registry), Layer.provide(permission), Layer.provide(todos))
const it = testEffect(Layer.mergeAll(database, events, todos, permission, registry, tool))

const setup = Effect.gen(function* () {
  assertions.length = 0
  deny = false
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: Project.ID.global,
      slug: "todowrite",
      directory: "/project",
      title: "todowrite",
      version: "test",
    })
    .run()
    .pipe(Effect.orDie)
})

const call = (todos: ReadonlyArray<SessionTodo.Info>, id = "call-todowrite", directory?: string) => ({
  sessionID,
  ...(directory === undefined ? {} : { directory }),
  ...toolIdentity,
  call: { type: "tool-call" as const, id, name: TodoWriteTool.name, input: { todos } },
})

describe("TodoWriteTool", () => {
  it.effect("registers, approves the wildcard resource, and returns typed output without a file-backed session", () =>
    Effect.gen(function* () {
      yield* setup
      const registry = yield* ToolRegistry.Service
      const service = yield* SessionTodo.Service
      const todoList = [{ content: "Implement slice", status: "in_progress", priority: "high" }]

      expect((yield* toolDefinitions(registry)).map((tool) => tool.name)).toEqual([TodoWriteTool.name])
      expect(yield* settleTool(registry, call(todoList))).toEqual({
        result: { type: "text", value: JSON.stringify(todoList, null, 2) },
        output: {
          structured: { todos: todoList },
          content: [{ type: "text", text: JSON.stringify(todoList, null, 2) }],
        },
      })
      expect(assertions).toMatchObject([{ sessionID, action: "todowrite", resources: ["*"], save: ["*"] }])
      expect(yield* service.get(sessionID)).toEqual([])
    }),
  )

  it.effect("does not persist todos without a file-backed session when permission is denied", () =>
    Effect.gen(function* () {
      yield* setup
      const registry = yield* ToolRegistry.Service
      const service = yield* SessionTodo.Service
      yield* service.update({ sessionID, todos: [{ content: "keep", status: "pending", priority: "low" }] })
      deny = true

      expect(
        yield* executeTool(registry, call([{ content: "blocked", status: "completed", priority: "high" }])),
      ).toEqual({
        type: "error",
        value: "Unable to update todos",
      })
      expect(yield* service.get(sessionID)).toEqual([])
      expect(assertions).toMatchObject([{ sessionID, action: "todowrite", resources: ["*"], save: ["*"] }])
    }),
  )

  it.effect("persists todos into a directory-backed session when the tool context has a directory", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((directory) =>
        Effect.gen(function* () {
          yield* setup
          const registry = yield* ToolRegistry.Service
          const service = yield* SessionTodo.Service
          const todoList = [{ content: "Persist locally", status: "pending", priority: "medium" }]
          yield* Effect.promise(() =>
            writeSessionStore({
              id: sessionID,
              projectID: Project.ID.global,
              title: "file-backed todowrite",
              location: { directory: AbsolutePath.make(directory.path) },
              time: { created: DateTime.makeUnsafe(1), updated: DateTime.makeUnsafe(1) },
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            }),
          )

          expect(yield* settleTool(registry, call(todoList, "call-todowrite-directory", directory.path))).toMatchObject(
            {
              result: { type: "text", value: JSON.stringify(todoList, null, 2) },
            },
          )
          expect(assertions).toMatchObject([
            { sessionID, directory: directory.path, action: "todowrite", resources: ["*"], save: ["*"] },
          ])
          expect(yield* service.get(sessionID, { directory: directory.path })).toEqual(todoList)
          expect(yield* Effect.promise(() => readSessionTodoProjection(directory.path, sessionID))).toEqual({
            hasState: true,
            todos: todoList,
          })
        }),
      ),
    ),
  )
})
