export * as SessionV2 from "./session"
export * from "./session/schema"

import { Cause, DateTime, Effect, Layer, Schema, Context, Stream } from "effect"
import { and, asc, desc, eq, gt, isNull, like, lt, or, type SQL } from "drizzle-orm"
import { ProjectV2 } from "./project"
import { WorkspaceV2 } from "./workspace"
import { ModelV2 } from "./model"
import { Location } from "./location"
import { SessionMessage } from "./session/message"
import { Prompt } from "./session/prompt"
import { EventV2 } from "./event"
import { Database } from "./database/database"
import { SessionProjector } from "./session/projector"
import { SessionMessageTable, SessionTable } from "./session/sql"
import { SessionSchema } from "./session/schema"
import { AbsolutePath, PositiveInt, RelativePath } from "./schema"
import { AgentV2 } from "./agent"
import { SessionV1 } from "./v1/session"
import { InstallationVersion } from "./installation/version"
import { Slug } from "./util/slug"
import { ProjectTable } from "./project/sql"
import path from "path"
import { fromRow } from "./session/info"
import { SessionRunner } from "./session/runner/index"
import { SessionStore } from "./session/store"
import { SessionExecution } from "./session/execution"
import { logFailure } from "./session/logging"
import { MessageDecodeError } from "./session/error"
import { SessionEvent } from "./session/event"
import { SessionInput } from "./session/input"
import { publishSessionEvent } from "./session/publish-session-event"
import {
  appendSessionJsonl,
  appendPromptJsonl,
  readSessionJsonlEntries,
  readSessionJsonlMessages,
  readSessionStore,
  readSessionStores,
  writeSessionStore,
} from "./atree/session-store"

// get project -> project.locations
//
// get all sessions
//

// - by project
//   - by subpath
// - by workspace (home is special)

export const ListAnchor = Schema.Struct({
  id: SessionSchema.ID,
  time: Schema.Finite,
  direction: Schema.Literals(["previous", "next"]),
})
export type ListAnchor = typeof ListAnchor.Type

const ListInputBase = {
  workspaceID: WorkspaceV2.ID.pipe(Schema.optional),
  search: Schema.String.pipe(Schema.optional),
  limit: PositiveInt.pipe(Schema.optional),
  order: Schema.Literals(["asc", "desc"]).pipe(Schema.optional),
  anchor: ListAnchor.pipe(Schema.optional),
  archived: Schema.Boolean.pipe(Schema.optional),
}

const ListDirectoryInput = Schema.Struct({
  ...ListInputBase,
  directory: AbsolutePath,
})

const ListProjectInput = Schema.Struct({
  ...ListInputBase,
  project: ProjectV2.ID,
  subpath: RelativePath.pipe(Schema.optional),
})

const ListAllInput = Schema.Struct(ListInputBase)

export const ListInput = Schema.Union([ListDirectoryInput, ListProjectInput, ListAllInput])
export type ListInput = typeof ListInput.Type

type CreateInput = {
  id?: SessionSchema.ID
  agent?: AgentV2.ID
  model?: ModelV2.Ref
  location: Location.Ref
}

type CompactInput = {
  sessionID: SessionSchema.ID
  prompt?: Prompt
}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("Session.NotFoundError", {
  sessionID: SessionSchema.ID,
}) {}

export class OperationUnavailableError extends Schema.TaggedErrorClass<OperationUnavailableError>()(
  "Session.OperationUnavailableError",
  {
    operation: Schema.Literals(["move", "shell", "skill", "switchAgent", "compact", "wait"]),
  },
) {}

export { ContextSnapshotDecodeError, MessageDecodeError } from "./session/error"

export class PromptConflictError extends Schema.TaggedErrorClass<PromptConflictError>()("Session.PromptConflictError", {
  sessionID: SessionSchema.ID,
  messageID: SessionMessage.ID,
}) {}

export type Error = NotFoundError | MessageDecodeError | OperationUnavailableError | PromptConflictError

function stableJson(value: unknown) {
  return JSON.stringify(value ?? null)
}

function promptsMatch(input: Prompt, existing: SessionMessage.User) {
  return (
    existing.text === input.text &&
    stableJson(existing.files) === stableJson(input.files) &&
    stableJson(existing.agents) === stableJson(input.agents)
  )
}

function sameDirectory(left: string, right: string) {
  return path.resolve(left) === path.resolve(right)
}

export interface Interface {
  readonly list: (input?: ListInput) => Effect.Effect<SessionSchema.Info[]>
  readonly create: (input: CreateInput) => Effect.Effect<SessionSchema.Info>
  readonly get: (
    sessionID: SessionSchema.ID,
    options?: { directory?: AbsolutePath },
  ) => Effect.Effect<SessionSchema.Info, NotFoundError>
  readonly messages: (input: {
    sessionID: SessionSchema.ID
    directory?: AbsolutePath
    limit?: number
    order?: "asc" | "desc"
    cursor?: {
      id: SessionMessage.ID
      direction: "previous" | "next"
    }
  }) => Effect.Effect<SessionMessage.Message[], NotFoundError | MessageDecodeError>
  readonly message: (input: {
    sessionID: SessionSchema.ID
    directory?: AbsolutePath
    messageID: SessionMessage.ID
  }) => Effect.Effect<SessionMessage.Message | undefined>
  readonly context: (
    sessionID: SessionSchema.ID,
    options?: { directory?: AbsolutePath },
  ) => Effect.Effect<SessionMessage.Message[], NotFoundError | MessageDecodeError>
  readonly events: (input: {
    sessionID: SessionSchema.ID
    directory?: AbsolutePath
    after?: EventV2.Cursor
  }) => Stream.Stream<EventV2.CursorEvent<SessionEvent.DurableEvent>, NotFoundError>
  readonly switchAgent: (input: {
    sessionID: SessionSchema.ID
    agent: string
  }) => Effect.Effect<void, OperationUnavailableError>
  readonly switchModel: (input: {
    sessionID: SessionSchema.ID
    directory?: AbsolutePath
    model: ModelV2.Ref
  }) => Effect.Effect<void, NotFoundError>
  readonly prompt: (input: {
    id?: SessionMessage.ID
    sessionID: SessionSchema.ID
    directory?: AbsolutePath
    prompt: Prompt
    delivery?: SessionInput.Delivery
    resume?: boolean
  }) => Effect.Effect<SessionInput.Admitted, NotFoundError | PromptConflictError>
  readonly shell: (input: {
    id?: EventV2.ID
    sessionID: SessionSchema.ID
    command: string
    resume?: boolean
  }) => Effect.Effect<void, OperationUnavailableError>
  readonly skill: (input: {
    id?: EventV2.ID
    sessionID: SessionSchema.ID
    skill: string
    resume?: boolean
  }) => Effect.Effect<void, OperationUnavailableError>
  readonly compact: (input: CompactInput) => Effect.Effect<void, NotFoundError | OperationUnavailableError>
  readonly wait: (id: SessionSchema.ID) => Effect.Effect<void, NotFoundError | OperationUnavailableError>
  readonly resume: (sessionID: SessionSchema.ID) => Effect.Effect<void, NotFoundError | SessionRunner.RunError>
  readonly interrupt: (
    sessionID: SessionSchema.ID,
    options?: { directory?: AbsolutePath },
  ) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Session") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const events = yield* EventV2.Service
    const projects = yield* ProjectV2.Service
    const execution = yield* SessionExecution.Service
    const store = yield* SessionStore.Service
    const decodeMessage = Schema.decodeUnknownEffect(SessionMessage.Message)
    const isDurableSessionEvent = Schema.is(SessionEvent.Durable)
    const scope = yield* Effect.scope

    const enqueueWake = (admitted: SessionInput.Admitted) =>
      execution.wake(admitted.sessionID, admitted.admittedSeq).pipe(
        Effect.tapCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.void
            : logFailure("Failed to wake Session", admitted.sessionID, cause),
        ),
        Effect.ignore,
        Effect.forkIn(scope, { startImmediately: true }),
        Effect.asVoid,
      )

    const decode = (row: typeof SessionMessageTable.$inferSelect) =>
      decodeMessage({ ...row.data, id: row.id, type: row.type }).pipe(
        Effect.mapError(
          () =>
            new MessageDecodeError({
              sessionID: SessionSchema.ID.make(row.session_id),
              messageID: SessionMessage.ID.make(row.id),
            }),
        ),
      )

    function sessionTimeCreated(info: SessionSchema.Info) {
      return DateTime.toEpochMillis(info.time.created)
    }

    function matchesListInput(info: SessionSchema.Info, input: ListInput, order: "asc" | "desc") {
      if ("directory" in input && !sameDirectory(info.location.directory, input.directory)) return false
      if (input.workspaceID && info.location.workspaceID !== input.workspaceID) return false
      if ("project" in input && info.projectID !== input.project) return false
      if (input.search && !info.title.includes(input.search)) return false
      if (!input.archived && info.time.archived !== undefined) return false
      if (input.anchor) {
        const created = sessionTimeCreated(info)
        const anchor = input.anchor
        if (order === "asc") {
          if (created < anchor.time) return false
          if (created === anchor.time && info.id <= anchor.id) return false
        } else {
          if (created > anchor.time) return false
          if (created === anchor.time && info.id >= anchor.id) return false
        }
      }
      return true
    }

    function pageFileMessages(
      messages: SessionMessage.Message[],
      input: {
        limit?: number
        order?: "asc" | "desc"
        cursor?: { id: SessionMessage.ID; direction: "previous" | "next" }
      },
    ) {
      const requestedOrder = input.order ?? "desc"
      const direction = input.cursor?.direction ?? "next"
      const order = direction === "previous" ? (requestedOrder === "asc" ? "desc" : "asc") : requestedOrder
      const sorted = messages.toSorted((a, b) => {
        const diff =
          DateTime.toEpochMillis(a.time.created) - DateTime.toEpochMillis(b.time.created) || a.id.localeCompare(b.id)
        return order === "asc" ? diff : -diff
      })
      const anchor = input.cursor ? sorted.findIndex((message) => message.id === input.cursor!.id) : -1
      const afterAnchor = anchor >= 0 ? sorted.slice(anchor + 1) : sorted
      const limited = input.limit === undefined ? afterAnchor : afterAnchor.slice(0, input.limit)
      return direction === "previous" ? limited.toReversed() : limited
    }

    const persistFileSession = Effect.fn("V2Session.persistFileSession")(function* (session: SessionSchema.Info) {
      yield* Effect.promise(() => writeSessionStore(session)).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("failed to persist atree session store", { sessionID: session.id, cause }),
        ),
      )
    })

    const persistFileSessionCreatedEvent = Effect.fn("V2Session.persistFileSessionCreatedEvent")(function* (
      session: SessionSchema.Info,
    ) {
      yield* Effect.promise(() =>
        appendSessionJsonl(session, {
          type: "session.created",
          sessionID: session.id,
          info: session,
        }),
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("failed to append atree session.created event", { sessionID: session.id, cause }),
        ),
      )
    })

    const fileBackedEvents = Effect.fn("V2Session.fileBackedEvents")(function* (
      session: SessionSchema.Info,
      after?: EventV2.Cursor,
    ) {
      const entries = yield* Effect.promise(() => readSessionJsonlEntries(session)).pipe(
        Effect.catchCause(() => Effect.succeed([] as Awaited<ReturnType<typeof readSessionJsonlEntries>>)),
      )
      return entries.flatMap(({ index, entry }) => {
        const type = typeof entry.type === "string" ? entry.type.replace(/\.\d+$/, "") : undefined
        if (!type?.startsWith("session.next.")) return []
        if (after !== undefined && index <= after) return []
        const data = entry.data && typeof entry.data === "object" ? entry.data : entry
        const definition = EventV2.registry.get(type)
        if (!definition) return []
        const decoded = Schema.decodeUnknownOption(definition.data as never)(data)
        if (decoded._tag === "None") return []
        const event = {
          id: EventV2.ID.make(`evt_atree_${session.id}_${index}`),
          type,
          ...(definition.sync === undefined ? {} : { version: definition.sync.version }),
          seq: index,
          data: decoded.value,
          location: session.location,
        }
        if (!isDurableSessionEvent(event)) return []
        return [{ cursor: EventV2.Cursor.make(index), event }]
      })
    })

    const result = Service.of({
      create: Effect.fn("V2Session.create")(function* (input) {
        const sessionID = input.id ?? SessionSchema.ID.create()
        const recorded = yield* store.get(sessionID)
        if (recorded) {
          yield* persistFileSession(recorded)
          return recorded
        }
        const project = yield* projects.resolve(input.location.directory)
        yield* db
          .insert(ProjectTable)
          .values({ id: project.id, worktree: project.directory, vcs: project.vcs?.type, sandboxes: [] })
          .onConflictDoNothing()
          .run()
          .pipe(Effect.orDie)
        const now = Date.now()
        const subpath = path.relative(project.directory, input.location.directory).replaceAll("\\", "/")
        const fileInfo = SessionSchema.Info.make({
          id: sessionID,
          projectID: project.id,
          title: `New session - ${new Date(now).toISOString()}`,
          agent: input.agent,
          model: input.model,
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: DateTime.makeUnsafe(now), updated: DateTime.makeUnsafe(now) },
          location: input.location,
          subpath: subpath ? RelativePath.make(subpath) : undefined,
        })
        const info = SessionV1.SessionInfo.make({
          id: sessionID,
          slug: Slug.create(),
          version: InstallationVersion,
          projectID: project.id,
          directory: input.location.directory,
          path: subpath,
          workspaceID: input.location.workspaceID ? WorkspaceV2.ID.make(input.location.workspaceID) : undefined,
          title: fileInfo.title,
          agent: input.agent,
          model: input.model
            ? {
                id: ModelV2.ID.make(input.model.id),
                providerID: input.model.providerID,
                variant: input.model.variant,
              }
            : undefined,
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: now, updated: now },
        })
        yield* persistFileSession(fileInfo)
        yield* persistFileSessionCreatedEvent(fileInfo)
        const projected = yield* events
          .publish(SessionV1.Event.Created, { sessionID, info }, { location: input.location })
          .pipe(
            Effect.as({ type: "created" } as const),
            Effect.catchDefect((defect) => {
              if (!(defect instanceof SessionProjector.SessionAlreadyProjected)) {
                return Effect.die(defect)
              }
              // Concurrent creation lost the projection race. The existing Session identity wins.
              return store
                .get(sessionID)
                .pipe(
                  Effect.flatMap((session) =>
                    session ? Effect.succeed({ type: "existing", session } as const) : Effect.die(defect),
                  ),
                )
            }),
          )
        if (projected.type === "existing") {
          yield* persistFileSession(projected.session)
          return projected.session
        }
        // TODO: Restore recorded sessions onto replacement synchronized workspaces in a future API slice.
        const created = yield* result.get(sessionID).pipe(Effect.orDie)
        yield* persistFileSession(created)
        return created
      }),
      get: Effect.fn("V2Session.get")(function* (sessionID, options) {
        const directory = options?.directory
        if (directory) {
          const fileSession = yield* Effect.promise(() => readSessionStore(directory, sessionID)).pipe(
            Effect.catchCause(() => Effect.succeed(undefined)),
          )
          if (fileSession) return fileSession
        }
        const session = yield* store.get(sessionID)
        if (!session) return yield* new NotFoundError({ sessionID })
        return session
      }),
      list: Effect.fn("V2Session.list")(function* (input = {}) {
        const direction = input.anchor?.direction ?? "next"
        const requestedOrder = input.order ?? "desc"
        const order = direction === "previous" ? (requestedOrder === "asc" ? "desc" : "asc") : requestedOrder
        const sortColumn = SessionTable.time_created
        const conditions: SQL[] = []
        if ("directory" in input) conditions.push(eq(SessionTable.directory, input.directory))
        if (input.workspaceID) conditions.push(eq(SessionTable.workspace_id, input.workspaceID))
        if ("project" in input) conditions.push(eq(SessionTable.project_id, input.project))
        if (input.search) conditions.push(like(SessionTable.title, `%${input.search}%`))
        if (!input.archived) conditions.push(isNull(SessionTable.time_archived))
        if (input.anchor) {
          conditions.push(
            order === "asc"
              ? or(
                  gt(sortColumn, input.anchor.time),
                  and(eq(sortColumn, input.anchor.time), gt(SessionTable.id, input.anchor.id)),
                )!
              : or(
                  lt(sortColumn, input.anchor.time),
                  and(eq(sortColumn, input.anchor.time), lt(SessionTable.id, input.anchor.id)),
                )!,
          )
        }
        const query = db
          .select()
          .from(SessionTable)
          .where(conditions.length > 0 ? and(...conditions) : undefined)
          .orderBy(
            order === "asc" ? asc(sortColumn) : desc(sortColumn),
            order === "asc" ? asc(SessionTable.id) : desc(SessionTable.id),
          )
        const rows = yield* (input.limit === undefined ? query.all() : query.limit(input.limit).all()).pipe(
          Effect.orDie,
        )
        const fileSessions = "directory" in input
          ? yield* Effect.promise(() => readSessionStores(input.directory)).pipe(
              Effect.catchCause(() => Effect.succeed([] as SessionSchema.Info[])),
            )
          : undefined
        const fileSessionIDs = fileSessions ? new Set(fileSessions.map((session) => session.id)) : undefined
        const byID = new Map<string, SessionSchema.Info>()
        for (const row of rows) {
          if (fileSessionIDs && !fileSessionIDs.has(row.id)) continue
          byID.set(row.id, fromRow(row))
        }
        if (fileSessions) {
          for (const fileSession of fileSessions) {
            byID.delete(fileSession.id)
            if (!matchesListInput(fileSession, input, order)) continue
            byID.set(fileSession.id, fileSession)
          }
        }
        const sessions = [...byID.values()].sort((a, b) => {
          const diff = sessionTimeCreated(a) - sessionTimeCreated(b) || a.id.localeCompare(b.id)
          return order === "asc" ? diff : -diff
        })
        const limited = input.limit === undefined ? sessions : sessions.slice(0, input.limit)
        return direction === "previous" ? limited.toReversed() : limited
      }),
      messages: Effect.fn("V2Session.messages")(function* (input) {
        const session = yield* result.get(input.sessionID, { directory: input.directory })
        const fileMessages = yield* Effect.promise(() => readSessionJsonlMessages(session)).pipe(
          Effect.catchCause(() => Effect.succeed([] as SessionMessage.Message[])),
        )
        const fileBacked = yield* Effect.promise(() => readSessionStore(session.location.directory, session.id)).pipe(
          Effect.catchCause(() => Effect.succeed(undefined)),
        )
        if (fileBacked) return pageFileMessages(fileMessages, input)
        const direction = input.cursor?.direction ?? "next"
        const requestedOrder = input.order ?? "desc"
        const order = direction === "previous" ? (requestedOrder === "asc" ? "desc" : "asc") : requestedOrder
        const anchor = input.cursor
          ? yield* db
              .select({ seq: SessionMessageTable.seq })
              .from(SessionMessageTable)
              .where(
                and(eq(SessionMessageTable.session_id, input.sessionID), eq(SessionMessageTable.id, input.cursor.id)),
              )
              .get()
              .pipe(Effect.orDie)
          : undefined
        if (input.cursor && !anchor) return []
        const boundary = anchor
          ? order === "asc"
            ? gt(SessionMessageTable.seq, anchor.seq)
            : lt(SessionMessageTable.seq, anchor.seq)
          : undefined
        const where = boundary
          ? and(eq(SessionMessageTable.session_id, input.sessionID), boundary)
          : eq(SessionMessageTable.session_id, input.sessionID)
        const query = db
          .select()
          .from(SessionMessageTable)
          .where(where)
          .orderBy(order === "asc" ? asc(SessionMessageTable.seq) : desc(SessionMessageTable.seq))
        const rows = yield* (input.limit === undefined ? query.all() : query.limit(input.limit).all()).pipe(
          Effect.orDie,
        )
        return yield* Effect.forEach(direction === "previous" ? rows.toReversed() : rows, decode)
      }),
      message: Effect.fn("V2Session.message")(function* (input) {
        const session = yield* result
          .get(input.sessionID, { directory: input.directory })
          .pipe(Effect.catchTag("Session.NotFoundError", () => Effect.succeed(undefined)))
        if (session) {
          const fileMessages = yield* Effect.promise(() => readSessionJsonlMessages(session)).pipe(
            Effect.catchCause(() => Effect.succeed([] as SessionMessage.Message[])),
          )
          const message = fileMessages.find((item) => item.id === input.messageID)
          if (message) return message
          const fileBacked = yield* Effect.promise(() => readSessionStore(session.location.directory, session.id)).pipe(
            Effect.catchCause(() => Effect.succeed(undefined)),
          )
          if (fileBacked) return undefined
        }
        const stored = yield* store.message(input.messageID)
        return stored?.sessionID === input.sessionID ? stored.message : undefined
      }),
      context: Effect.fn("V2Session.context")(function* (sessionID, options) {
        const session = yield* result.get(sessionID, { directory: options?.directory })
        const fileMessages = yield* Effect.promise(() => readSessionJsonlMessages(session)).pipe(
          Effect.catchCause(() => Effect.succeed([] as SessionMessage.Message[])),
        )
        const fileBacked = yield* Effect.promise(() => readSessionStore(session.location.directory, session.id)).pipe(
          Effect.catchCause(() => Effect.succeed(undefined)),
        )
        if (fileBacked) return fileMessages
        return yield* store.context(sessionID)
      }),
      events: (input) =>
        Stream.unwrap(
          result
            .get(input.sessionID, { directory: input.directory })
            .pipe(
              Effect.flatMap((session) =>
                Effect.gen(function* () {
                  const fileBacked = yield* Effect.promise(() =>
                    readSessionStore(session.location.directory, session.id),
                  ).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
                  if (fileBacked) {
                    return Stream.fromIterable(yield* fileBackedEvents(session, input.after))
                  }
                  return events.aggregateEvents({ aggregateID: input.sessionID, after: input.after })
                }),
              ),
            ),
        ).pipe(
          Stream.filter((event): event is EventV2.CursorEvent<SessionEvent.DurableEvent> =>
            isDurableSessionEvent(event.event),
          ),
        ),
      prompt: Effect.fn("V2Session.prompt")((input) =>
        Effect.uninterruptible(
          Effect.gen(function* () {
            const session = yield* result.get(input.sessionID, { directory: input.directory })
            const sessionRow = yield* db
              .select({ id: SessionTable.id, directory: SessionTable.directory })
              .from(SessionTable)
              .where(eq(SessionTable.id, input.sessionID))
              .get()
              .pipe(Effect.orDie)
            const matchingSessionRow =
              sessionRow && sameDirectory(sessionRow.directory, session.location.directory) ? sessionRow : undefined
            const messageID = input.id ?? SessionMessage.ID.create()
            const fileMessages = yield* Effect.promise(() => readSessionJsonlMessages(session)).pipe(
              Effect.catchCause(() => Effect.succeed([] as SessionMessage.Message[])),
            )
            const existingFileMessage = fileMessages.find((message) => message.id === messageID)
            const fileBacked = yield* Effect.promise(() => readSessionStore(session.location.directory, session.id)).pipe(
              Effect.catchCause(() => Effect.succeed(undefined)),
            )
            if (existingFileMessage && (!matchingSessionRow || fileBacked)) {
              if (existingFileMessage.type !== "user" || !promptsMatch(input.prompt, existingFileMessage))
                return yield* new PromptConflictError({ sessionID: input.sessionID, messageID })
              return new SessionInput.Admitted({
                admittedSeq: 0,
                id: messageID,
                sessionID: input.sessionID,
                prompt: input.prompt,
                delivery: input.delivery ?? "steer",
                timeCreated: existingFileMessage.time.created,
              })
            }
            if (!matchingSessionRow) {
              const admitted = new SessionInput.Admitted({
                admittedSeq: 0,
                id: messageID,
                sessionID: input.sessionID,
                prompt: input.prompt,
                delivery: input.delivery ?? "steer",
                timeCreated: yield* DateTime.now,
              })
              yield* Effect.promise(() => appendPromptJsonl(session, admitted)).pipe(Effect.orDie)
              return admitted
            }
            const returnPrompt = Effect.fnUntraced(function* (admitted: SessionInput.Admitted) {
              if (input.resume !== false) yield* enqueueWake(admitted)
              return admitted
            }, Effect.uninterruptible)
            const delivery = input.delivery ?? "steer"
            const expected = { sessionID: input.sessionID, messageID, prompt: input.prompt, delivery }
            const admitted = yield* SessionInput.admit(db, events, {
              id: messageID,
              sessionID: input.sessionID,
              prompt: input.prompt,
              delivery,
            }).pipe(
              Effect.catchDefect((defect) =>
                defect instanceof SessionInput.LifecycleConflict
                  ? new PromptConflictError({ sessionID: input.sessionID, messageID })
                  : Effect.die(defect),
              ),
            )
            if (!SessionInput.equivalent(admitted, expected))
              return yield* new PromptConflictError({ sessionID: input.sessionID, messageID })
            yield* Effect.promise(() => appendPromptJsonl(session, admitted)).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("failed to mirror prompt into atree session store", {
                  sessionID: input.sessionID,
                  messageID,
                  cause,
                }),
              ),
            )
            return yield* returnPrompt(admitted)
          }),
        ),
      ),
      shell: Effect.fn("V2Session.shell")(function* () {
        return yield* new OperationUnavailableError({ operation: "shell" })
      }),
      skill: Effect.fn("V2Session.skill")(function* () {
        return yield* new OperationUnavailableError({ operation: "skill" })
      }),
      switchAgent: Effect.fn("V2Session.switchAgent")(function* () {
        return yield* new OperationUnavailableError({ operation: "switchAgent" })
      }),
      switchModel: Effect.fn("V2Session.switchModel")(function* (input) {
        const session = yield* result.get(input.sessionID, { directory: input.directory })
        const sessionRow = yield* db
          .select({ id: SessionTable.id, directory: SessionTable.directory })
          .from(SessionTable)
          .where(eq(SessionTable.id, input.sessionID))
          .get()
          .pipe(Effect.orDie)
        const matchingSessionRow =
          sessionRow && sameDirectory(sessionRow.directory, session.location.directory) ? sessionRow : undefined
        const fileBacked = yield* Effect.promise(() => readSessionStore(session.location.directory, session.id)).pipe(
          Effect.catchCause(() => Effect.succeed(undefined)),
        )
        const timestamp = yield* DateTime.now
        const messageID = SessionMessage.ID.create()
        yield* Effect.promise(() =>
          appendSessionJsonl(session, {
            type: SessionEvent.ModelSwitched.type,
            sessionID: input.sessionID,
            messageID,
            timestamp,
            model: input.model,
          }),
        ).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("failed to append model switch event to atree session log", {
              sessionID: input.sessionID,
              messageID,
              cause,
            }),
          ),
        )
        if (fileBacked && !matchingSessionRow) return
        yield* events.publish(SessionEvent.ModelSwitched, {
          sessionID: input.sessionID,
          messageID,
          timestamp,
          model: input.model,
        })
      }),
      compact: Effect.fn("V2Session.compact")(function* (input) {
        yield* result.get(input.sessionID)
        return yield* new OperationUnavailableError({ operation: "compact" })
      }),
      wait: Effect.fn("V2Session.wait")(function* (sessionID) {
        yield* result.get(sessionID)
        return yield* new OperationUnavailableError({ operation: "wait" })
      }),
      resume: Effect.fn("V2Session.resume")(function* (sessionID) {
        yield* result.get(sessionID)
        yield* execution.resume(sessionID)
      }),
      interrupt: Effect.fn("V2Session.interrupt")((sessionID, options) =>
        Effect.uninterruptible(
          Effect.gen(function* () {
            const session = yield* result
              .get(sessionID, { directory: options?.directory })
              .pipe(Effect.catchTag("Session.NotFoundError", () => Effect.succeed(undefined)))
            if (!session) return yield* execution.interrupt(sessionID)
            const sessionRow = yield* db
              .select({ id: SessionTable.id, directory: SessionTable.directory })
              .from(SessionTable)
              .where(eq(SessionTable.id, sessionID))
              .get()
              .pipe(Effect.orDie)
            const matchingSessionRow =
              sessionRow && sameDirectory(sessionRow.directory, session.location.directory) ? sessionRow : undefined
            const fileBacked = yield* Effect.promise(() => readSessionStore(session.location.directory, session.id)).pipe(
              Effect.catchCause(() => Effect.succeed(undefined)),
            )
            const timestamp = yield* DateTime.now
            if (fileBacked && !matchingSessionRow) {
              yield* Effect.promise(() =>
                appendSessionJsonl(session, {
                  type: SessionEvent.InterruptRequested.type,
                  sessionID,
                  timestamp,
                }),
              ).pipe(Effect.orDie)
              return yield* execution.interrupt(sessionID)
            }
            const event = yield* publishSessionEvent(
              events,
              { sessionID, session },
              SessionEvent.InterruptRequested,
              {
                sessionID,
                timestamp,
              },
              "interrupt request event",
            )
            if (event.seq === undefined)
              return yield* Effect.die("Interrupt request event is missing aggregate sequence")
            yield* execution.interrupt(sessionID, event.seq)
          }),
        ),
      ),
    })

    return result
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(SessionExecution.noopLayer),
  Layer.provide(SessionStore.defaultLayer),
  Layer.provide(SessionProjector.defaultLayer),
  Layer.provide(EventV2.defaultLayer),
  Layer.provide(Database.defaultLayer),
  Layer.provide(ProjectV2.defaultLayer),
  Layer.orDie,
)
