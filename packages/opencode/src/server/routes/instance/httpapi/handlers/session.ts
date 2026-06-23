import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Agent } from "@/agent/agent"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Command } from "@/command"
import { Permission } from "@/permission"
import { Session } from "@/session/session"
import { SessionCompaction } from "@/session/compaction"
import { MessageV2 } from "@/session/message-v2"
import { SessionPrompt } from "@/session/prompt"
import { SessionRevert } from "@/session/revert"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { SessionSummary } from "@/session/summary"
import { Todo } from "@/session/todo"
import { Schedule } from "@/session/schedule"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { InstanceState } from "@/effect/instance-state"
import { NamedError } from "@opencode-ai/core/util/error"
import { Cause, Effect, Option, Schema, Scope } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder, HttpApiError, HttpApiSchema } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import {
  CommandPayload,
  DiffQuery,
  ForkPayload,
  InitPayload,
  ListQuery,
  MessagesQuery,
  PermissionResponsePayload,
  PromptPayload,
  RevertPayload,
  SchedulePayload,
  ShellPayload,
  SummarizePayload,
  UpdatePayload,
} from "../groups/session"
import { PermissionNotFoundError, notFound } from "../errors"
import * as SessionError from "./session-errors"
import { buildScheduleCreateInput } from "@/session/schedule-input"
import { NotFoundError } from "@/storage/storage"
import path from "path"

const tryParseJson = (text: string) =>
  Effect.try({
    try: () => JSON.parse(text) as unknown,
    catch: () => new HttpApiError.BadRequest({}),
  })

function messageCreated(item: SessionV1.WithParts) {
  return item.info.time.created
}

function olderThanCursor(item: SessionV1.WithParts, cursor: { id: MessageID; time: number }) {
  const created = messageCreated(item)
  return created < cursor.time || (created === cursor.time && item.info.id < cursor.id)
}

function pageMessages(items: SessionV1.WithParts[], input: { limit: number; before?: { id: MessageID; time: number } }) {
  const candidates = input.before ? items.filter((item) => olderThanCursor(item, input.before!)) : items
  const pageWithExtra = candidates.slice(Math.max(0, candidates.length - (input.limit + 1)))
  const more = pageWithExtra.length > input.limit
  const page = more ? pageWithExtra.slice(1) : pageWithExtra
  const cursorItem = more ? page[0] : undefined
  return {
    items: page,
    cursor: cursorItem
      ? MessageV2.cursor.encode({ id: cursorItem.info.id as MessageID, time: messageCreated(cursorItem) })
      : undefined,
  }
}

export const sessionHandlers = HttpApiBuilder.group(InstanceHttpApi, "session", (handlers) =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    const promptSvc = yield* SessionPrompt.Service
    const revertSvc = yield* SessionRevert.Service
    const compactSvc = yield* SessionCompaction.Service
    const runState = yield* SessionRunState.Service
    const agentSvc = yield* Agent.Service
    const permissionSvc = yield* Permission.Service
    const statusSvc = yield* SessionStatus.Service
    const todoSvc = yield* Todo.Service
    const scheduleSvc = yield* Schedule.Service
    const summary = yield* SessionSummary.Service
    const events = yield* EventV2Bridge.Service
    const scope = yield* Scope.Scope

    const list = Effect.fn("SessionHttpApi.list")(function* (ctx: { query: typeof ListQuery.Type }) {
      const directory =
        ctx.query.scope === "project" ? undefined : ctx.query.directory ?? (yield* InstanceState.context).directory
      return yield* session.list({
        directory,
        scope: ctx.query.scope,
        path: ctx.query.path,
        roots: ctx.query.roots,
        start: ctx.query.start,
        search: ctx.query.search,
        limit: ctx.query.limit,
        archived: ctx.query.archived,
      })
    })

    const status = Effect.fn("SessionHttpApi.status")(function* () {
      return Object.fromEntries(yield* statusSvc.list())
    })

    const requireSession = Effect.fn("SessionHttpApi.requireSession")(function* (sessionID: SessionID) {
      const context = yield* InstanceState.context.pipe(
        Effect.catchCause(() => Effect.succeed({ directory: undefined } as { directory?: string })),
      )
      const scoped = session.get(sessionID, { directory: context.directory })
      const found = context.directory
        ? yield* scoped.pipe(
            Effect.catchIf(NotFoundError.isInstance, () =>
              session.get(sessionID).pipe(
                Effect.flatMap((fallback) =>
                  path.resolve(fallback.directory) === path.resolve(context.directory!)
                    ? Effect.fail(new NotFoundError({ message: `Session not found: ${sessionID}` }))
                    : Effect.succeed(fallback),
                ),
              ),
            ),
            SessionError.mapStorageNotFound,
          )
        : yield* SessionError.mapStorageNotFound(scoped)
      return found
    })

    const get = Effect.fn("SessionHttpApi.get")(function* (ctx: { params: { sessionID: SessionID } }) {
      return yield* requireSession(ctx.params.sessionID)
    })

    const children = Effect.fn("SessionHttpApi.children")(function* (ctx: { params: { sessionID: SessionID } }) {
      const info = yield* requireSession(ctx.params.sessionID)
      return yield* session.children(ctx.params.sessionID, { directory: info.directory })
    })

    const todo = Effect.fn("SessionHttpApi.todo")(function* (ctx: { params: { sessionID: SessionID } }) {
      const info = yield* requireSession(ctx.params.sessionID)
      return yield* todoSvc.get(ctx.params.sessionID, { directory: info.directory })
    })

    const schedules = Effect.fn("SessionHttpApi.schedules")(function* (ctx: { params: { sessionID: SessionID } }) {
      const info = yield* requireSession(ctx.params.sessionID)
      return yield* scheduleSvc.list(ctx.params.sessionID, { directory: info.directory })
    })

    const createSchedule = Effect.fn("SessionHttpApi.createSchedule")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof SchedulePayload.Type
    }) {
      const info = yield* requireSession(ctx.params.sessionID)
      const resolved = buildScheduleCreateInput(ctx.payload)
      return yield* scheduleSvc
        .create({
          sessionID: ctx.params.sessionID,
          directory: info.directory,
          kind: resolved.kind,
          expression: resolved.expression?.trim(),
          runAt: resolved.runAt,
          message: ctx.payload.message,
        })
        .pipe(Effect.mapError(() => new HttpApiError.BadRequest({})))
    })

    const deleteSchedule = Effect.fn("SessionHttpApi.deleteSchedule")(function* (ctx: {
      params: { sessionID: SessionID; scheduleID: Schedule.ID }
    }) {
      const info = yield* requireSession(ctx.params.sessionID)
      yield* scheduleSvc.list(ctx.params.sessionID, { directory: info.directory })
      return yield* scheduleSvc.delete(ctx.params.scheduleID, { directory: info.directory }).pipe(
        Effect.map(() => true),
        Effect.catchTag("ScheduleNotFound", () => Effect.fail(notFound("Schedule not found"))),
      )
    })

    const diff = Effect.fn("SessionHttpApi.diff")(function* (ctx: {
      params: { sessionID: SessionID }
      query: typeof DiffQuery.Type
    }) {
      const info = yield* requireSession(ctx.params.sessionID).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
      if (!info) return []
      return yield* summary.diff({
        sessionID: ctx.params.sessionID,
        directory: info.directory,
        messageID: ctx.query.messageID,
      })
    })

    const messages = Effect.fn("SessionHttpApi.messages")(function* (ctx: {
      params: { sessionID: SessionID }
      query: typeof MessagesQuery.Type
    }) {
      if (ctx.query.before && ctx.query.limit === undefined) return yield* new HttpApiError.BadRequest({})
      let before: { id: MessageID; time: number } | undefined
      if (ctx.query.before) {
        before = yield* Effect.try({
          try: () => MessageV2.cursor.decode(ctx.query.before!),
          catch: () => new HttpApiError.BadRequest({}),
        })
      }
      const info = yield* requireSession(ctx.params.sessionID)
      const allMessages = yield* SessionError.mapStorageNotFound(
        session.messages({ sessionID: ctx.params.sessionID, directory: info.directory }),
      )
      if (ctx.query.limit === undefined || ctx.query.limit === 0) {
        return allMessages
      }

      const page = pageMessages(allMessages, { limit: ctx.query.limit, before })
      if (!page.cursor) return page.items

      const request = yield* HttpServerRequest.HttpServerRequest
      // toURL() honors the Host + x-forwarded-proto headers, so the Link
      // header echoes the real origin instead of a hard-coded localhost.
      const url = Option.getOrElse(HttpServerRequest.toURL(request), () => new URL(request.url, "http://localhost"))
      url.searchParams.set("limit", ctx.query.limit.toString())
      url.searchParams.set("before", page.cursor)
      return HttpServerResponse.jsonUnsafe(page.items, {
        headers: {
          "Access-Control-Expose-Headers": "Link, X-Next-Cursor",
          Link: `<${url.toString()}>; rel="next"`,
          "X-Next-Cursor": page.cursor,
        },
      })
    })

    const message = Effect.fn("SessionHttpApi.message")(function* (ctx: {
      params: { sessionID: SessionID; messageID: MessageID }
    }) {
      const info = yield* requireSession(ctx.params.sessionID)
      const result = yield* SessionError.mapStorageNotFound(
        session.findMessage(ctx.params.sessionID, (item) => item.info.id === ctx.params.messageID, {
          directory: info.directory,
        }),
      )
      if (Option.isNone(result)) {
        return yield* Effect.fail(notFound(`Message not found: ${ctx.params.messageID}`))
      }
      return result.value
    })

    const create = Effect.fn("SessionHttpApi.create")(function* (ctx: { payload?: Session.CreateInput }) {
      return yield* session.create(ctx.payload)
    })

    const createRaw = Effect.fn("SessionHttpApi.createRaw")(function* (ctx: {
      request: HttpServerRequest.HttpServerRequest
    }) {
      const body = yield* Effect.orDie(ctx.request.text)
      if (body.trim().length === 0) return yield* create({})

      const json = yield* tryParseJson(body)
      const decoded = yield* Schema.decodeUnknownEffect(Session.CreateInput)(json).pipe(
        Effect.mapError(() => new HttpApiError.BadRequest({})),
      )
      const payload = decoded
        ? {
            ...decoded,
            permission: decoded.permission ? [...decoded.permission] : undefined,
          }
        : decoded
      return yield* create({ payload })
    })

    const remove = Effect.fn("SessionHttpApi.remove")(function* (ctx: { params: { sessionID: SessionID } }) {
      const current = yield* requireSession(ctx.params.sessionID)
      yield* SessionError.mapStorageNotFound(session.remove(ctx.params.sessionID, { directory: current.directory }))
      return true
    })

    const update = Effect.fn("SessionHttpApi.update")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof UpdatePayload.Type
    }) {
      const current = yield* requireSession(ctx.params.sessionID)
      if (ctx.payload.title !== undefined) {
        yield* session.setTitle({ sessionID: ctx.params.sessionID, directory: current.directory, title: ctx.payload.title })
      }
      if (ctx.payload.metadata !== undefined) {
        yield* session.setMetadata({
          sessionID: ctx.params.sessionID,
          directory: current.directory,
          metadata: ctx.payload.metadata,
        })
      }
      if (ctx.payload.permission !== undefined) {
        yield* session.setPermission({
          sessionID: ctx.params.sessionID,
          permission: Permission.merge(current.permission ?? [], ctx.payload.permission),
          directory: current.directory,
        })
      }
      if (ctx.payload.time?.archived !== undefined) {
        if (ctx.payload.time.archived !== null) {
          yield* scheduleSvc.clear(ctx.params.sessionID, { directory: current.directory })
        }
        yield* session.setArchived({
          sessionID: ctx.params.sessionID,
          directory: current.directory,
          time: ctx.payload.time.archived,
        })
      }
      return yield* requireSession(ctx.params.sessionID)
    })

    const fork = Effect.fn("SessionHttpApi.fork")(function* (ctx: {
      params: { sessionID: SessionID }
      payload?: typeof ForkPayload.Type
    }) {
      const current = yield* requireSession(ctx.params.sessionID)
      return yield* SessionError.mapStorageNotFound(
        session.fork({
          sessionID: ctx.params.sessionID,
          directory: current.directory,
          messageID: ctx.payload?.messageID,
        }),
      )
    })

    const forkRaw = Effect.fn("SessionHttpApi.forkRaw")(function* (ctx: {
      params: { sessionID: SessionID }
      request: HttpServerRequest.HttpServerRequest
    }) {
      const body = yield* Effect.orDie(ctx.request.text)
      if (body.trim().length === 0) return yield* fork({ params: ctx.params })

      const json = yield* tryParseJson(body)
      const payload = yield* Schema.decodeUnknownEffect(ForkPayload)(json).pipe(
        Effect.mapError(() => new HttpApiError.BadRequest({})),
      )
      return yield* fork({ params: ctx.params, payload })
    })

    const abort = Effect.fn("SessionHttpApi.abort")(function* (ctx: { params: { sessionID: SessionID } }) {
      const current = yield* requireSession(ctx.params.sessionID).pipe(
        Effect.catchCause(() => Effect.succeed(undefined)),
      )
      yield* promptSvc.cancel(ctx.params.sessionID, { directory: current?.directory })
      return true
    })

    const init = Effect.fn("SessionHttpApi.init")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof InitPayload.Type
    }) {
      const info = yield* requireSession(ctx.params.sessionID)
      yield* promptSvc
        .command({
          sessionID: ctx.params.sessionID,
          directory: info.directory,
          messageID: ctx.payload.messageID,
          model: `${ctx.payload.providerID}/${ctx.payload.modelID}`,
          command: Command.Default.INIT,
          arguments: "",
        })
        .pipe(Effect.mapError(() => new HttpApiError.BadRequest({})))
      return true
    })

    const summarize = Effect.fn("SessionHttpApi.summarize")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof SummarizePayload.Type
    }) {
      const info = yield* requireSession(ctx.params.sessionID)
      yield* revertSvc.cleanup(info)
      const messages = yield* SessionError.mapStorageNotFound(
        session.messages({ sessionID: ctx.params.sessionID, directory: info.directory }),
      )
      const defaultAgent = yield* agentSvc.defaultAgent()
      const currentAgent = messages.findLast((message) => message.info.role === "user")?.info.agent ?? defaultAgent

      yield* compactSvc.create({
        sessionID: ctx.params.sessionID,
        directory: info.directory,
        agent: currentAgent,
        model: {
          providerID: ctx.payload.providerID,
          modelID: ctx.payload.modelID,
        },
        auto: ctx.payload.auto ?? false,
      })
      yield* promptSvc.loop({ sessionID: ctx.params.sessionID, directory: info.directory })
      return true
    })

    const prompt = Effect.fn("SessionHttpApi.prompt")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof PromptPayload.Type
    }) {
      const info = yield* requireSession(ctx.params.sessionID)
      const message = yield* promptSvc
        .prompt({
          ...ctx.payload,
          sessionID: ctx.params.sessionID,
          directory: info.directory,
        })
        .pipe(Effect.mapError(() => new HttpApiError.BadRequest({})))
      return HttpServerResponse.jsonUnsafe(message)
    })

    const promptAsync = Effect.fn("SessionHttpApi.promptAsync")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof PromptPayload.Type
    }) {
      const info = yield* requireSession(ctx.params.sessionID)
      yield* promptSvc.prompt({ ...ctx.payload, sessionID: ctx.params.sessionID, directory: info.directory }).pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            yield* Effect.logError("prompt_async failed", { sessionID: ctx.params.sessionID, cause })
            yield* events.publish(Session.Event.Error, {
              sessionID: ctx.params.sessionID,
              error: new NamedError.Unknown({ message: Cause.pretty(cause) }).toObject(),
            })
          }),
        ),
        Effect.forkIn(scope, { startImmediately: true }),
      )
      return HttpApiSchema.NoContent.make()
    })

    const command = Effect.fn("SessionHttpApi.command")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof CommandPayload.Type
    }) {
      const info = yield* requireSession(ctx.params.sessionID)
      return yield* promptSvc
        .command({ ...ctx.payload, sessionID: ctx.params.sessionID, directory: info.directory })
        .pipe(Effect.mapError(() => new HttpApiError.BadRequest({})))
    })

    const shell = Effect.fn("SessionHttpApi.shell")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof ShellPayload.Type
    }) {
      const info = yield* requireSession(ctx.params.sessionID)
      return yield* SessionError.mapBusy(
        promptSvc.shell({ ...ctx.payload, sessionID: ctx.params.sessionID, directory: info.directory }),
      )
    })

    const revert = Effect.fn("SessionHttpApi.revert")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof RevertPayload.Type
    }) {
      const info = yield* requireSession(ctx.params.sessionID)
      return yield* SessionError.mapBusy(
        revertSvc.revert({ sessionID: ctx.params.sessionID, directory: info.directory, ...ctx.payload }),
      )
    })

    const unrevert = Effect.fn("SessionHttpApi.unrevert")(function* (ctx: { params: { sessionID: SessionID } }) {
      const info = yield* requireSession(ctx.params.sessionID)
      return yield* SessionError.mapBusy(revertSvc.unrevert({ sessionID: ctx.params.sessionID, directory: info.directory }))
    })

    const permissionRespond = Effect.fn("SessionHttpApi.permissionRespond")(function* (ctx: {
      params: { sessionID: SessionID; permissionID: PermissionV1.ID }
      payload: typeof PermissionResponsePayload.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      yield* permissionSvc.reply({ requestID: ctx.params.permissionID, reply: ctx.payload.response }).pipe(
        Effect.catchTag("Permission.NotFoundError", (error) =>
          Effect.fail(
            new PermissionNotFoundError({
              requestID: String(error.requestID),
              message: `Permission request not found: ${error.requestID}`,
            }),
          ),
        ),
      )
      return true
    })

    const deleteMessage = Effect.fn("SessionHttpApi.deleteMessage")(function* (ctx: {
      params: { sessionID: SessionID; messageID: MessageID }
    }) {
      const info = yield* requireSession(ctx.params.sessionID)
      yield* SessionError.mapBusy(runState.assertNotBusy(ctx.params.sessionID, { directory: info.directory }))
      yield* session.removeMessage({ ...ctx.params, directory: info.directory })
      return true
    })

    const deletePart = Effect.fn("SessionHttpApi.deletePart")(function* (ctx: {
      params: { sessionID: SessionID; messageID: MessageID; partID: PartID }
    }) {
      const info = yield* requireSession(ctx.params.sessionID)
      yield* session.removePart({ ...ctx.params, directory: info.directory })
      return true
    })

    const updatePart = Effect.fn("SessionHttpApi.updatePart")(function* (ctx: {
      params: { sessionID: SessionID; messageID: MessageID; partID: PartID }
      payload: typeof SessionV1.Part.Type
    }) {
      const info = yield* requireSession(ctx.params.sessionID)
      const payload = ctx.payload as SessionV1.Part
      if (
        payload.id !== ctx.params.partID ||
        payload.messageID !== ctx.params.messageID ||
        payload.sessionID !== ctx.params.sessionID
      ) {
        return yield* new HttpApiError.BadRequest({})
      }
      return yield* session.updatePart(payload, { directory: info.directory })
    })

    return handlers
      .handle("list", list)
      .handle("status", status)
      .handle("get", get)
      .handle("children", children)
      .handle("todo", todo)
      .handle("schedules", schedules)
      .handle("createSchedule", createSchedule)
      .handle("deleteSchedule", deleteSchedule)
      .handle("diff", diff)
      .handle("messages", messages)
      .handle("message", message)
      .handleRaw("create", createRaw)
      .handle("remove", remove)
      .handle("update", update)
      .handleRaw("fork", forkRaw)
      .handle("abort", abort)
      .handle("init", init)
      .handle("summarize", summarize)
      .handle("prompt", prompt)
      .handle("promptAsync", promptAsync)
      .handle("command", command)
      .handle("shell", shell)
      .handle("revert", revert)
      .handle("unrevert", unrevert)
      .handle("permissionRespond", permissionRespond)
      .handle("deleteMessage", deleteMessage)
      .handle("deletePart", deletePart)
      .handle("updatePart", updatePart)
  }),
)
