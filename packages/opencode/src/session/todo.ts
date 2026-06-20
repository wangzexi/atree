import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionID } from "./schema"
import { Effect, Layer, Context, Schema } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { eq } from "drizzle-orm"
import { asc } from "drizzle-orm"
import { SessionTable, TodoTable } from "@opencode-ai/core/session/sql"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { EventV2Bridge } from "@/event-v2-bridge"
import { EventV2 } from "@opencode-ai/core/event"
import { findSessionStore, readSessionStore } from "@/atree/session-store"
import { readSessionTodoProjection, writeSessionTodoState } from "@/atree/todo-store"
import { readWorkspaceState } from "@/atree/state"
import { InstanceRef } from "@/effect/instance-ref"

export const Info = Schema.Struct({
  content: Schema.String.annotate({ description: "Brief description of the task" }),
  status: Schema.String.annotate({
    description: "Current status of the task: pending, in_progress, completed, cancelled",
  }),
  priority: Schema.String.annotate({ description: "Priority level of the task: high, medium, low" }),
}).annotate({ identifier: "Todo" })
export type Info = Schema.Schema.Type<typeof Info>

export const Event = {
  Updated: EventV2.define({
    type: "todo.updated",
    schema: {
      sessionID: SessionID,
      todos: Schema.Array(Info),
    },
  }),
}

export interface Interface {
  readonly update: (input: { sessionID: SessionID; todos: Info[]; directory?: string }) => Effect.Effect<void>
  readonly get: (sessionID: SessionID, options?: { directory?: string }) => Effect.Effect<Info[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionTodo") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const { db } = yield* Database.Service

    type FileSession = NonNullable<Awaited<ReturnType<typeof readSessionStore>>>

    const ensureFileSessionProject = Effect.fn("Todo.ensureFileSessionProject")(function* (session: FileSession) {
      const existing = yield* db
        .select({ id: ProjectTable.id })
        .from(ProjectTable)
        .where(eq(ProjectTable.id, session.projectID))
        .get()
        .pipe(Effect.orDie)
      if (existing) return
      const now = Date.now()
      yield* db
        .insert(ProjectTable)
        .values({
          id: session.projectID,
          worktree: AbsolutePath.make(session.directory),
          vcs: null,
          name: null,
          time_created: now,
          time_updated: now,
          sandboxes: [],
        } as typeof ProjectTable.$inferInsert)
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
    })

    const upsertFileSessionCache = Effect.fn("Todo.upsertFileSessionCache")(function* (session: FileSession) {
      const instance = yield* InstanceRef
      const tokens = session.tokens ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
      const projectID = instance?.project.id ?? session.projectID
      yield* ensureFileSessionProject({ ...session, projectID })
      const row = {
        id: session.id,
        project_id: projectID,
        workspace_id: session.workspaceID ?? null,
        parent_id: session.parentID ?? null,
        slug: session.slug,
        directory: session.directory,
        path: session.path ?? null,
        title: session.title,
        agent: session.agent ?? null,
        model: session.model ?? null,
        version: session.version,
        share_url: session.share?.url ?? null,
        summary_additions: session.summary?.additions ?? null,
        summary_deletions: session.summary?.deletions ?? null,
        summary_files: session.summary?.files ?? null,
        summary_diffs: session.summary?.diffs ?? null,
        revert: session.revert ?? null,
        metadata: session.metadata ?? null,
        permission: session.permission ?? null,
        cost: session.cost,
        tokens_input: tokens.input,
        tokens_output: tokens.output,
        tokens_reasoning: tokens.reasoning,
        tokens_cache_read: tokens.cache.read,
        tokens_cache_write: tokens.cache.write,
        time_created: session.time.created,
        time_updated: session.time.updated,
        time_compacting: session.time.compacting ?? null,
        time_archived: session.time.archived ?? null,
      } as typeof SessionTable.$inferInsert
      yield* db
        .insert(SessionTable)
        .values(row)
        .onConflictDoUpdate({ target: SessionTable.id, set: row })
        .run()
        .pipe(Effect.orDie)
    })

    const sessionDirectory = Effect.fn("Todo.sessionDirectory")(function* (
      sessionID: SessionID,
      fallbackDirectory?: string,
    ) {
      if (fallbackDirectory) {
        const fileSession = yield* Effect.promise(() => readSessionStore(fallbackDirectory, sessionID))
        if (fileSession) {
          yield* upsertFileSessionCache(fileSession)
          return fileSession.directory
        }
      }

      const row = yield* db
        .select({ directory: SessionTable.directory })
        .from(SessionTable)
        .where(eq(SessionTable.id, sessionID))
        .get()
        .pipe(Effect.orDie)
      if (row?.directory) {
        const fileSession = yield* Effect.promise(() => readSessionStore(row.directory, sessionID))
        if (fileSession) {
          yield* upsertFileSessionCache(fileSession)
          return fileSession.directory
        }
      }

      const instance = yield* InstanceRef
      if (instance) {
        const fileSession = yield* Effect.promise(() => readSessionStore(instance.directory, sessionID))
        if (fileSession) return instance.directory
      }

      const state = yield* Effect.promise(() => readWorkspaceState()).pipe(
        Effect.catchCause(() => Effect.succeed({ rootDirectory: null })),
      )
      if (!state.rootDirectory) return
      const fileSession = yield* Effect.promise(() => findSessionStore(state.rootDirectory!, sessionID))
      if (!fileSession) return
      yield* upsertFileSessionCache(fileSession)
      return fileSession.directory
    })

    const update = Effect.fn("Todo.update")(function* (input: {
      sessionID: SessionID
      todos: Info[]
      directory?: string
    }) {
      const directory = yield* sessionDirectory(input.sessionID, input.directory)
      const fileSession = directory
        ? yield* Effect.promise(() => readSessionStore(directory, input.sessionID))
        : undefined
      if (fileSession) yield* upsertFileSessionCache(fileSession)
      yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* tx.delete(TodoTable).where(eq(TodoTable.session_id, input.sessionID)).run()
            if (input.todos.length === 0) return
            yield* tx
              .insert(TodoTable)
              .values(
                input.todos.map((todo, position) => ({
                  session_id: input.sessionID,
                  content: todo.content,
                  status: todo.status,
                  priority: todo.priority,
                  position,
                })),
              )
              .run()
          }),
        )
        .pipe(Effect.orDie)
      if (directory) yield* Effect.promise(() => writeSessionTodoState(directory, input.sessionID, input.todos))
      yield* events.publish(Event.Updated, input)
    })

    const get = Effect.fn("Todo.get")(function* (sessionID: SessionID, options?: { directory?: string }) {
      const directory = yield* sessionDirectory(sessionID, options?.directory)
      if (directory) {
        const projection = yield* Effect.promise(() => readSessionTodoProjection(directory, sessionID))
        if (projection.hasState) return projection.todos
      }

      const rows = yield* db
        .select()
        .from(TodoTable)
        .where(eq(TodoTable.session_id, sessionID))
        .orderBy(asc(TodoTable.position))
        .all()
        .pipe(Effect.orDie)
      return rows.map((row) => ({
        content: row.content,
        status: row.status,
        priority: row.priority,
      }))
    })

    return Service.of({ update, get })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(EventV2Bridge.defaultLayer), Layer.provide(Database.defaultLayer))

export const node = LayerNode.make(layer, [EventV2Bridge.node, Database.node])

export * as Todo from "./todo"
