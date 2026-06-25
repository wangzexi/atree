export * as SessionContextEpoch from "./context-epoch"

import { and, eq, isNull, lt, or, sql } from "drizzle-orm"
import { DateTime, Effect, Schema } from "effect"
import { AgentV2 } from "../agent"
import { readSessionPromptStatesByID, readSessionStore } from "../atree/session-store"
import type { Database } from "../database/database"
import { EventV2 } from "../event"
import { Location } from "../location"
import { ProjectTable } from "../project/sql"
import { SystemContext } from "../system-context/index"
import { ContextSnapshotDecodeError } from "./error"
import { SessionEvent } from "./event"
import { SessionInput } from "./input"
import { SessionMessageID } from "./message-id"
import { publishSessionEvent } from "./publish-session-event"
import { SessionSchema } from "./schema"
import { SessionContextEpochTable, SessionTable } from "./sql"

type DatabaseService = Database.Interface["db"]

class RevisionMismatch extends Error {}
class LocationMismatch extends Error {}
export class AgentMismatch extends Error {}
export class AgentReplacementBlocked extends Schema.TaggedErrorClass<AgentReplacementBlocked>()(
  "SessionContextEpoch.AgentReplacementBlocked",
  { sessionID: SessionSchema.ID, previous: AgentV2.ID, current: AgentV2.ID },
) {}

const retryRevisionMismatch = <A, E>(attempt: () => Effect.Effect<A, E>): Effect.Effect<A, E> =>
  attempt().pipe(
    Effect.catchDefect((defect) =>
      defect instanceof RevisionMismatch
        ? Effect.yieldNow.pipe(Effect.andThen(retryRevisionMismatch(attempt)))
        : Effect.die(defect),
    ),
  )

interface Prepared {
  readonly baseline: string
  readonly baselineSeq: number
  readonly revision: number
}

export function initialize(
  db: DatabaseService,
  context: Effect.Effect<SystemContext.SystemContext>,
  sessionID: SessionSchema.ID,
  location: Location.Ref,
  agent: AgentV2.ID,
): Effect.Effect<Prepared | undefined, SystemContext.InitializationBlocked> {
  return retryRevisionMismatch(() => initializeOnce(db, context, sessionID, location, agent)).pipe(
    Effect.withSpan("SessionContextEpoch.initialize"),
  )
}

export function prepare(
  db: DatabaseService,
  events: EventV2.Interface,
  context: Effect.Effect<SystemContext.SystemContext>,
  sessionID: SessionSchema.ID,
  location: Location.Ref,
  agent: AgentV2.ID,
): Effect.Effect<Prepared, SystemContext.InitializationBlocked | ContextSnapshotDecodeError | AgentReplacementBlocked> {
  return retryRevisionMismatch(() => prepareOnce(db, events, context, sessionID, location, agent)).pipe(
    Effect.withSpan("SessionContextEpoch.prepare"),
  )
}

const prepareOnce = Effect.fnUntraced(function* (
  db: DatabaseService,
  events: EventV2.Interface,
  context: Effect.Effect<SystemContext.SystemContext>,
  sessionID: SessionSchema.ID,
  location: Location.Ref,
  agent: AgentV2.ID,
) {
  const placement = yield* ensurePlacedSession(db, sessionID, location)
  if (placement === "rebound") yield* reset(db, sessionID)
  const [value, stored] = yield* Effect.all([context, find(db, sessionID)], { concurrency: "unbounded" })
  if (!stored) {
    const generation = yield* SystemContext.initialize(value)
    const baselineSeq = yield* insert(db, sessionID, location, agent, generation)
    return { baseline: generation.baseline, baselineSeq, revision: 0 }
  }

  const snapshot = yield* Schema.decodeUnknownEffect(SystemContext.Snapshot)(stored.snapshot).pipe(
    Effect.mapError((error) => new ContextSnapshotDecodeError({ sessionID, details: String(error) })),
  )
  const replacingAgent = stored.agent !== agent
  const result =
    stored.replacement_seq === null && !replacingAgent
      ? yield* SystemContext.reconcile(value, snapshot)
      : yield* SystemContext.replace(value, snapshot)
  if (result._tag === "ReplacementBlocked" && replacingAgent) {
    yield* fence(db, sessionID, agent, stored.revision)
    return yield* new AgentReplacementBlocked({ sessionID, previous: stored.agent, current: agent })
  }
  if (result._tag === "Unchanged" || result._tag === "ReplacementBlocked") {
    yield* fence(db, sessionID, agent, stored.revision)
    return { baseline: stored.baseline, baselineSeq: stored.baseline_seq, revision: stored.revision }
  }
  if (result._tag === "ReplacementReady") {
    const replacementSeq = stored.replacement_seq ?? (yield* latestInputSeq(db, sessionID, location))
    yield* replace(db, sessionID, agent, stored.revision, replacementSeq, result.generation)
    return { baseline: result.generation.baseline, baselineSeq: replacementSeq, revision: stored.revision + 1 }
  }

  const session = yield* Effect.promise(() => readSessionStore(location.directory, sessionID)).pipe(
    Effect.catchCause(() => Effect.succeed(undefined)),
  )
  yield* publishSessionEvent(
    events,
    { sessionID, session },
    SessionEvent.ContextUpdated,
    { sessionID, messageID: SessionMessageID.ID.create(), timestamp: yield* DateTime.now, text: result.text },
    "context update event",
    { commit: () => advance(db, sessionID, stored.revision, result.snapshot).pipe(Effect.orDie) },
  )
  return { baseline: stored.baseline, baselineSeq: stored.baseline_seq, revision: stored.revision + 1 }
})

const initializeOnce = Effect.fnUntraced(function* (
  db: DatabaseService,
  context: Effect.Effect<SystemContext.SystemContext>,
  sessionID: SessionSchema.ID,
  location: Location.Ref,
  agent: AgentV2.ID,
) {
  const placement = yield* ensurePlacedSession(db, sessionID, location)
  if (placement === "rebound") yield* reset(db, sessionID)
  if (yield* exists(db, sessionID)) return
  const generation = yield* context.pipe(Effect.flatMap(SystemContext.initialize))
  const baselineSeq = yield* insert(db, sessionID, location, agent, generation)
  return { baseline: generation.baseline, baselineSeq, revision: 0 }
})

const exists = Effect.fn("SessionContextEpoch.exists")(function* (db: DatabaseService, sessionID: SessionSchema.ID) {
  return (
    (yield* db
      .select({ sessionID: SessionContextEpochTable.session_id })
      .from(SessionContextEpochTable)
      .where(eq(SessionContextEpochTable.session_id, sessionID))
      .get()
      .pipe(Effect.orDie)) !== undefined
  )
})

const find = Effect.fn("SessionContextEpoch.find")(function* (db: DatabaseService, sessionID: SessionSchema.ID) {
  return yield* db
    .select()
    .from(SessionContextEpochTable)
    .where(eq(SessionContextEpochTable.session_id, sessionID))
    .get()
    .pipe(Effect.orDie)
})

const requireAgentSelection = Effect.fnUntraced(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  agent: AgentV2.ID,
) {
  const selected = yield* db
    .select({ agent: SessionTable.agent })
    .from(SessionTable)
    .where(eq(SessionTable.id, sessionID))
    .get()
    .pipe(Effect.orDie)
  if (selected && selected.agent !== null && selected.agent !== agent) return yield* Effect.die(new AgentMismatch())
})

const latestInputSeq = Effect.fnUntraced(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  location: Location.Ref,
) {
  const fileStates = yield* Effect.promise(() => readSessionPromptStatesByID(location.directory, sessionID)).pipe(
    Effect.catchCause(() => Effect.succeed(new Map())),
  )
  if (fileStates.size > 0)
    return Math.max(-1, ...[...fileStates.values()].map((state) => state.promotedSeq ?? state.admittedSeq))
  const fileSession = yield* Effect.promise(() => readSessionStore(location.directory, sessionID)).pipe(
    Effect.catchCause(() => Effect.succeed(undefined)),
  )
  if (fileSession) return -1
  return yield* SessionInput.latestSeq(db, sessionID)
})

export const requestReplacement = Effect.fn("SessionContextEpoch.requestReplacement")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  seq: number,
) {
  return yield* db
    .update(SessionContextEpochTable)
    .set({ replacement_seq: seq, revision: sql`${SessionContextEpochTable.revision} + 1` })
    .where(
      and(
        eq(SessionContextEpochTable.session_id, sessionID),
        lt(SessionContextEpochTable.baseline_seq, seq),
        or(isNull(SessionContextEpochTable.replacement_seq), lt(SessionContextEpochTable.replacement_seq, seq)),
      ),
    )
    .run()
    .pipe(Effect.orDie)
})

export const reset = Effect.fn("SessionContextEpoch.reset")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
) {
  yield* db
    .delete(SessionContextEpochTable)
    .where(eq(SessionContextEpochTable.session_id, sessionID))
    .run()
    .pipe(Effect.orDie)
})

const insert = Effect.fnUntraced(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  location: Location.Ref,
  agent: AgentV2.ID,
  generation: SystemContext.Generation,
) {
  yield* ensurePlacedSession(db, sessionID, location)
  const baselineSeq = yield* latestInputSeq(db, sessionID, location)
  return yield* db
    .transaction(
      () =>
        Effect.gen(function* () {
          const placed = yield* db
            .select({ agent: SessionTable.agent })
            .from(SessionTable)
            .where(
              and(
                eq(SessionTable.id, sessionID),
                eq(SessionTable.directory, location.directory),
                location.workspaceID === undefined
                  ? isNull(SessionTable.workspace_id)
                  : eq(SessionTable.workspace_id, location.workspaceID),
              ),
            )
            .get()
            .pipe(Effect.orDie)
          if (!placed) return yield* Effect.die(new LocationMismatch())
          if (placed.agent !== null && placed.agent !== agent) return yield* Effect.die(new AgentMismatch())
          yield* db
            .insert(SessionContextEpochTable)
            .values({
              session_id: sessionID,
              baseline: generation.baseline,
              agent,
              snapshot: generation.snapshot,
              baseline_seq: baselineSeq,
              revision: 0,
            })
            .onConflictDoNothing()
            .returning({ sessionID: SessionContextEpochTable.session_id })
            .get()
            .pipe(
              Effect.orDie,
              Effect.flatMap((inserted) => (inserted ? Effect.void : Effect.die(new RevisionMismatch()))),
            )
          return baselineSeq
        }),
      { behavior: "immediate" },
    )
    .pipe(Effect.orDie)
})

const ensurePlacedSession = Effect.fnUntraced(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  location: Location.Ref,
) {
  const placed = yield* db
    .select({
      id: SessionTable.id,
      directory: SessionTable.directory,
      workspaceID: SessionTable.workspace_id,
    })
    .from(SessionTable)
    .where(eq(SessionTable.id, sessionID))
    .get()
    .pipe(Effect.orDie)
  if (placed && sameLocation(placed.directory, placed.workspaceID ?? undefined, location)) return "present"
  const session = yield* Effect.promise(() => readSessionStore(location.directory, sessionID)).pipe(
    Effect.catchCause(() => Effect.succeed(undefined)),
  )
  if (!session) return "missing"
  yield* db
    .insert(ProjectTable)
    .values({
      id: session.projectID,
      worktree: location.directory,
      vcs: null,
      name: null,
      time_created: DateTime.toEpochMillis(session.time.created),
      time_updated: DateTime.toEpochMillis(session.time.updated),
      sandboxes: [],
    } as typeof ProjectTable.$inferInsert)
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  const tokens = session.tokens ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
  const insertValues = {
    id: session.id,
    project_id: session.projectID,
    workspace_id: session.location.workspaceID ?? null,
    parent_id: session.parentID ?? null,
    slug: session.id,
    directory: session.location.directory,
    path: session.subpath ?? null,
    title: session.title,
    agent: session.agent ?? null,
    model: session.model
      ? {
          id: session.model.id,
          providerID: session.model.providerID,
          variant: session.model.variant,
        }
      : null,
    version: "core",
    cost: session.cost ?? 0,
    tokens_input: tokens.input,
    tokens_output: tokens.output,
    tokens_reasoning: tokens.reasoning,
    tokens_cache_read: tokens.cache.read,
    tokens_cache_write: tokens.cache.write,
    time_created: DateTime.toEpochMillis(session.time.created),
    time_updated: DateTime.toEpochMillis(session.time.updated),
    time_archived: session.time.archived ? DateTime.toEpochMillis(session.time.archived) : null,
  } as const satisfies typeof SessionTable.$inferInsert
  if (!placed) {
    yield* db.insert(SessionTable).values(insertValues).onConflictDoNothing().run().pipe(Effect.orDie)
    return "inserted"
  }
  const updateValues = {
    project_id: session.projectID,
    workspace_id: session.location.workspaceID ?? null,
    parent_id: session.parentID ?? null,
    slug: session.id,
    directory: session.location.directory,
    path: session.subpath ?? null,
    title: session.title,
    agent: session.agent ?? null,
    model: session.model
      ? {
          id: session.model.id,
          providerID: session.model.providerID,
          variant: session.model.variant,
        }
      : null,
    version: "core",
    cost: session.cost ?? 0,
    tokens_input: tokens.input,
    tokens_output: tokens.output,
    tokens_reasoning: tokens.reasoning,
    tokens_cache_read: tokens.cache.read,
    tokens_cache_write: tokens.cache.write,
    time_created: DateTime.toEpochMillis(session.time.created),
    time_updated: DateTime.toEpochMillis(session.time.updated),
    time_archived: session.time.archived ? DateTime.toEpochMillis(session.time.archived) : null,
  } as const satisfies Partial<typeof SessionTable.$inferInsert>
  yield* db
    .update(SessionTable)
    .set(updateValues)
    .where(eq(SessionTable.id, sessionID))
    .run()
    .pipe(Effect.orDie)
  return "rebound"
})

const sameLocation = (directory: string, workspaceID: string | undefined, location: Location.Ref) =>
  directory === location.directory && workspaceID === location.workspaceID

const replace = Effect.fnUntraced(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  agent: AgentV2.ID,
  expectedRevision: number,
  baselineSeq: number,
  generation: SystemContext.Generation,
) {
  yield* db
    .transaction(
      () =>
        Effect.gen(function* () {
          yield* requireAgentSelection(db, sessionID, agent)
          const updated = yield* db
            .update(SessionContextEpochTable)
            .set({
              baseline: generation.baseline,
              agent,
              snapshot: generation.snapshot,
              baseline_seq: baselineSeq,
              replacement_seq: null,
              revision: expectedRevision + 1,
            })
            .where(
              and(
                eq(SessionContextEpochTable.session_id, sessionID),
                eq(SessionContextEpochTable.revision, expectedRevision),
              ),
            )
            .returning({ revision: SessionContextEpochTable.revision })
            .get()
            .pipe(Effect.orDie)
          if (!updated) return yield* Effect.die(new RevisionMismatch())
        }),
      { behavior: "immediate" },
    )
    .pipe(Effect.orDie)
})

const fence = Effect.fnUntraced(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  agent: AgentV2.ID,
  expectedRevision: number,
) {
  const current = yield* db
    .select({ selected: SessionTable.agent, revision: SessionContextEpochTable.revision })
    .from(SessionContextEpochTable)
    .leftJoin(SessionTable, eq(SessionTable.id, SessionContextEpochTable.session_id))
    .where(eq(SessionContextEpochTable.session_id, sessionID))
    .get()
    .pipe(Effect.orDie)
  if (!current || (current.selected !== null && current.selected !== agent))
    return yield* Effect.die(new AgentMismatch())
  if (current.revision !== expectedRevision) return yield* Effect.die(new RevisionMismatch())
})

export const current = Effect.fn("SessionContextEpoch.current")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  agent: AgentV2.ID,
  revision: number,
) {
  const value = yield* db
    .select({
      agent: SessionContextEpochTable.agent,
      selected: SessionTable.agent,
      revision: SessionContextEpochTable.revision,
    })
    .from(SessionContextEpochTable)
    .leftJoin(SessionTable, eq(SessionTable.id, SessionContextEpochTable.session_id))
    .where(eq(SessionContextEpochTable.session_id, sessionID))
    .get()
    .pipe(Effect.orDie)
  return (
    value !== undefined &&
    value.agent === agent &&
    (value.selected === null || value.selected === agent) &&
    value.revision === revision
  )
})

const advance = Effect.fnUntraced(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  expectedRevision: number,
  snapshot: SystemContext.Snapshot,
) {
  const updated = yield* db
    .update(SessionContextEpochTable)
    .set({ snapshot, revision: expectedRevision + 1 })
    .where(
      and(
        eq(SessionContextEpochTable.session_id, sessionID),
        eq(SessionContextEpochTable.revision, expectedRevision),
        isNull(SessionContextEpochTable.replacement_seq),
      ),
    )
    .returning({ revision: SessionContextEpochTable.revision })
    .get()
    .pipe(Effect.orDie)
  if (!updated) return yield* Effect.die(new RevisionMismatch())
})
