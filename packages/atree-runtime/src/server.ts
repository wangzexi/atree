import { homedir } from "node:os"
import { EventHub } from "./events"
import { AtreeStore, type DueSchedule } from "./store"

type Json = Record<string, unknown>

const store = new AtreeStore()
const events = new EventHub()
const trackedDirectories = new Set<string>()
const runningScheduleKeys = new Set<string>()
let scheduleTickRunning = false

const piProvider = {
  id: "pi",
  name: "Pi",
  env: [],
  models: {
    pi: {
      id: "pi",
      name: "Pi",
      release_date: "2026-06-16",
      attachment: true,
      reasoning: true,
      temperature: true,
      tool_call: true,
      limit: {
        context: 1_000_000,
        output: 64_000,
      },
      modalities: {
        input: ["text", "image", "pdf"],
        output: ["text"],
      },
      status: "active",
      options: {},
    },
  },
}

const piProviderList = {
  all: [piProvider],
  connected: [piProvider.id],
  default: {
    [piProvider.id]: "pi",
  },
}

const piAgent = {
  name: "pi",
  description: "Pi coding agent",
  mode: "primary",
  model: {
    providerID: piProvider.id,
    modelID: "pi",
  },
  permission: {
    edit: "allow",
    bash: {},
  },
  tools: {},
  options: {},
}

function decodeHeader(value: string | null) {
  if (!value) return undefined
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

async function requestJson(request: Request): Promise<Json> {
  const text = await request.text()
  if (!text.trim()) return {}
  return JSON.parse(text) as Json
}

async function directoryFrom(request: Request, url: URL) {
  const query =
    url.searchParams.get("directory") ??
    url.searchParams.get("location[directory]") ??
    decodeHeader(request.headers.get("x-opencode-directory"))
  const directory = await store.resolveDirectory(query ?? process.cwd())
  trackedDirectories.add(directory)
  return directory
}

function json(value: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "*",
      "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
      ...init?.headers,
    },
  })
}

function empty(init?: ResponseInit) {
  return new Response(null, {
    ...init,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "*",
      "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
      ...init?.headers,
    },
  })
}

function notFound() {
  return json({ message: "Not found" }, { status: 404 })
}

function withCors(response: Response) {
  const headers = new Headers(response.headers)
  headers.set("access-control-allow-origin", "*")
  headers.set("access-control-allow-headers", "*")
  headers.set("access-control-allow-methods", "GET,POST,PATCH,DELETE,OPTIONS")
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

function project(directory: string) {
  return {
    id: `prj_${Buffer.from(directory).toString("base64url").slice(0, 32)}`,
    worktree: directory,
    time: { created: Date.now(), updated: Date.now() },
    name: directory.split("/").filter(Boolean).at(-1) ?? "workspace",
    vcs: "none",
  }
}

function publish(directory: string, type: string, properties: Json) {
  events.publish({
    directory,
    payload: { type, properties },
  })
}

async function createSession(directory: string, body?: Json) {
  const session = await store.createSession(directory, {
    title: typeof body?.title === "string" ? body.title : undefined,
    metadata: isRecord(body?.metadata) ? body.metadata : undefined,
  })
  publish(directory, "session.created", { info: session })
  return session
}

function hasDirectorySelector(request: Request, url: URL) {
  return (
    url.searchParams.has("directory") ||
    url.searchParams.has("location[directory]") ||
    request.headers.has("x-opencode-directory")
  )
}

async function directoryForSession(request: Request, url: URL, directory: string, sessionID: string) {
  if (hasDirectorySelector(request, url)) return directory
  if (await store.readMeta(directory, sessionID)) return directory
  for (const tracked of trackedDirectories) {
    if (tracked === directory) continue
    if (await store.readMeta(tracked, sessionID)) return tracked
  }
  return directory
}

async function updateSession(directory: string, sessionID: string, body: Json) {
  const session = await store.updateSession(directory, sessionID, {
    title: typeof body.title === "string" ? body.title : undefined,
    metadata: isRecord(body.metadata) ? body.metadata : undefined,
    time: isRecord(body.time)
      ? {
          archived:
            typeof body.time.archived === "number" || body.time.archived === null ? body.time.archived : undefined,
        }
      : undefined,
  })
  publish(directory, "session.updated", { info: session })
  return session
}

async function deleteSession(directory: string, sessionID: string) {
  const info = await store.getSession(directory, sessionID).catch(() => undefined)
  await store.deleteSession(directory, sessionID)
  publish(directory, "session.deleted", { info: info ?? { id: sessionID, directory } })
  return true
}

async function runPromptAsync(directory: string, sessionID: string, body: Json) {
  if (store.canRunPiPrompt()) {
    publish(directory, "session.status", { sessionID, status: { type: "busy" } })
    try {
      const messages = await store.runPiPrompt(directory, sessionID, {
        parts: body.parts,
        source: isRecord(body.source) ? body.source : undefined,
        publish: (type, properties) => publish(directory, type, properties),
      })
      for (const message of messages) {
        publish(directory, "message.updated", { info: message.info })
        for (const part of message.parts) publish(directory, "message.part.updated", { part })
      }
    } catch (error) {
      publish(directory, "session.error", {
        sessionID,
        error: {
          message: error instanceof Error ? error.message : String(error),
        },
      })
      throw error
    } finally {
      publish(directory, "session.status", { sessionID, status: { type: "idle" } })
    }
    return empty({ status: 204 })
  }

  const message = await store.appendUserPrompt(directory, sessionID, {
    messageID: typeof body.messageID === "string" ? body.messageID : undefined,
    agent: typeof body.agent === "string" ? body.agent : undefined,
    model: isRecord(body.model) ? body.model : undefined,
    parts: body.parts,
    source: isRecord(body.source) ? body.source : undefined,
  })
  publish(directory, "message.updated", { info: message.info })
  for (const part of message.parts) publish(directory, "message.part.updated", { part })
  publish(directory, "session.status", { sessionID, status: { type: "idle" } })
  return empty({ status: 204 })
}

async function runDueSchedule(directory: string, due: DueSchedule) {
  const key = `${directory}:${due.sessionID}:${due.schedule.id}`
  if (runningScheduleKeys.has(key)) return
  runningScheduleKeys.add(key)
  const source = {
    type: "schedule",
    scheduleID: due.schedule.id,
    scheduleKind: due.schedule.kind,
    runAt: due.runAt,
  }
  try {
    if (store.canRunPiPrompt()) {
      publish(directory, "session.status", { sessionID: due.sessionID, status: { type: "busy" } })
      const messages = await store.runPiPrompt(directory, due.sessionID, {
        parts: [{ type: "text", text: due.schedule.message }],
        source,
        publish: (type, properties) => publish(directory, type, properties),
      })
      for (const message of messages) {
        publish(directory, "message.updated", { info: message.info })
        for (const part of message.parts) publish(directory, "message.part.updated", { part })
      }
    } else {
      const message = await store.appendUserPrompt(directory, due.sessionID, {
        agent: "automation",
        parts: [{ type: "text", text: due.schedule.message }],
        source,
      })
      publish(directory, "message.updated", { info: message.info })
      for (const part of message.parts) publish(directory, "message.part.updated", { part })
    }

    const completed = await store.completeDueSchedule(directory, due.sessionID, due.schedule.id, {
      status: "ran",
    })
    publish(directory, "schedule.ran", {
      sessionID: due.sessionID,
      scheduleID: due.schedule.id,
      schedule: due.info,
      status: "ran",
      ranAt: Date.now(),
      source: "atree-scheduler",
    })
    if (completed === "deleted")
      publish(directory, "schedule.deleted", { sessionID: due.sessionID, scheduleID: due.schedule.id })

    const info = await store.getSession(directory, due.sessionID).catch(() => undefined)
    if (info) publish(directory, "session.updated", { info })
    publish(directory, "session.status", { sessionID: due.sessionID, status: { type: "idle" } })
  } catch (error) {
    const completed = await store
      .completeDueSchedule(directory, due.sessionID, due.schedule.id, {
        status: "skipped",
      })
      .catch(() => "missing" as const)
    publish(directory, "schedule.ran", {
      sessionID: due.sessionID,
      scheduleID: due.schedule.id,
      schedule: due.info,
      status: "skipped",
      ranAt: Date.now(),
      source: "atree-scheduler",
    })
    if (completed === "deleted")
      publish(directory, "schedule.deleted", { sessionID: due.sessionID, scheduleID: due.schedule.id })
    publish(directory, "session.error", {
      sessionID: due.sessionID,
      scheduleID: due.schedule.id,
      error: {
        message: error instanceof Error ? error.message : String(error),
      },
    })
    publish(directory, "session.status", { sessionID: due.sessionID, status: { type: "idle" } })
  } finally {
    runningScheduleKeys.delete(key)
  }
}

async function runDueSchedules() {
  if (scheduleTickRunning) return
  scheduleTickRunning = true
  try {
    for (const directory of trackedDirectories) {
      const due = await store.listDueSchedules(directory).catch((error) => {
        console.error("Failed to scan due atree schedules", error)
        return [] as DueSchedule[]
      })
      for (const item of due) await runDueSchedule(directory, item)
    }
  } finally {
    scheduleTickRunning = false
  }
}

const scheduleTicker = setInterval(() => {
  void runDueSchedules()
}, 1_000)
;(scheduleTicker as { unref?: () => void }).unref?.()

function sessionRoutes(pathname: string) {
  const parts = pathname.split("/").filter(Boolean)
  if (parts[0] !== "session") return
  return parts.slice(1)
}

function atreeRoutes(pathname: string) {
  const parts = pathname.split("/").filter(Boolean)
  if (parts[0] !== "atree") return
  return parts.slice(1)
}

export async function handle(request: Request): Promise<Response> {
  if (request.method === "OPTIONS") return empty()

  const url = new URL(request.url)
  const pathname = url.pathname.replace(/\/+$/, "") || "/"

  try {
    if (pathname === "/global/health") return json({ healthy: true, version: "atree-pi-spike" })
    if (pathname === "/global/event") {
      return new Response(events.stream(), {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache, no-transform",
          "x-accel-buffering": "no",
          "access-control-allow-origin": "*",
        },
      })
    }
    if (pathname === "/global/config") return json({})
    if (pathname === "/config") return json({})
    if (pathname === "/api/provider" || pathname === "/provider") return json(piProviderList)
    if (pathname === "/agent") return json([piAgent])
    if (pathname === "/command") return json([])
    if (pathname === "/mcp") return json({})
    if (pathname === "/lsp") return json([])
    if (pathname === "/permission") return json([])
    if (pathname === "/vcs") return json({ branch: undefined, default_branch: undefined })
    if (pathname === "/vcs/status") return json([])

    let directory = await directoryFrom(request, url)

    const atreeRoute = atreeRoutes(pathname)
    if (atreeRoute) {
      if (atreeRoute[0] === "session") {
        if (atreeRoute.length === 1) {
          if (request.method === "GET") {
            const limit = Number(url.searchParams.get("limit") ?? 0) || undefined
            const includeArchived = url.searchParams.get("includeArchived") === "true"
            return json(await store.listNativeSessions(directory, { includeArchived, limit }))
          }
          if (request.method === "POST") {
            const created = await createSession(directory, await requestJson(request))
            return json(await store.getNativeSession(directory, created.id))
          }
        }

        const sessionID = atreeRoute[1]
        if (!sessionID) return notFound()
        directory = await directoryForSession(request, url, directory, sessionID)

        if (atreeRoute.length === 2) {
          if (request.method === "GET") return json(await store.getNativeSession(directory, sessionID))
          if (request.method === "PATCH") {
            await updateSession(directory, sessionID, await requestJson(request))
            return json(await store.getNativeSession(directory, sessionID))
          }
          if (request.method === "DELETE") return json(await deleteSession(directory, sessionID))
        }
        if (atreeRoute.length === 3 && atreeRoute[2] === "entries" && request.method === "GET") {
          return json(await store.listNativeEntries(directory, sessionID))
        }
        if (atreeRoute.length === 3 && atreeRoute[2] === "prompt_async" && request.method === "POST") {
          return runPromptAsync(directory, sessionID, await requestJson(request))
        }
        if (atreeRoute[2] === "schedule") {
          if (atreeRoute.length === 3) {
            if (request.method === "GET") return json(await store.listSchedules(directory, sessionID))
            if (request.method === "POST") {
              const body = await requestJson(request)
              const schedule = await store.createSchedule(directory, sessionID, {
                type: body.type === "cron" || body.type === "at" ? body.type : undefined,
                cron: typeof body.cron === "string" ? body.cron : undefined,
                at: typeof body.at === "string" || typeof body.at === "number" ? body.at : undefined,
                message: typeof body.message === "string" ? body.message : "",
              })
              publish(directory, "schedule.created", { sessionID, scheduleID: schedule.id })
              return json(schedule)
            }
          }
          if (atreeRoute.length === 4 && request.method === "DELETE") {
            const deleted = await store.deleteSchedule(directory, sessionID, atreeRoute[3]!)
            publish(directory, "schedule.deleted", { sessionID, scheduleID: atreeRoute[3] })
            return json(deleted)
          }
        }
      }
      return notFound()
    }

    if (pathname === "/skill") return json(await store.listSkills(directory))
    if (pathname === "/question") return json([])

    if (pathname === "/path") {
      return json({
        state: "",
        config: "",
        worktree: directory,
        directory,
        home: homedir(),
      })
    }

    if (pathname === "/project") return json([project(directory)])
    if (pathname === "/project/current") return json(project(directory))

    const sessionRoute = sessionRoutes(pathname)
    if (sessionRoute) {
      if (sessionRoute.length === 0) {
        if (request.method === "GET") {
          const limit = Number(url.searchParams.get("limit") ?? 0) || undefined
          const includeArchived = url.searchParams.get("includeArchived") === "true"
          return json(await store.listSessions(directory, { includeArchived, limit }))
        }
        if (request.method === "POST") return json(await createSession(directory, await requestJson(request)))
      }

      if (sessionRoute[0] === "status" && request.method === "GET") return json({})

      const sessionID = sessionRoute[0]
      if (!sessionID) return notFound()
      directory = await directoryForSession(request, url, directory, sessionID)

      if (sessionRoute.length === 1) {
        if (request.method === "GET") return json(await store.getSession(directory, sessionID))
        if (request.method === "PATCH")
          return json(await updateSession(directory, sessionID, await requestJson(request)))
        if (request.method === "DELETE") return json(await deleteSession(directory, sessionID))
      }

      if (sessionRoute[1] === "message") {
        if (request.method === "GET") return json(await store.listMessages(directory, sessionID))
        if (request.method === "POST") {
          const body = await requestJson(request)
          const message = await store.appendUserPrompt(directory, sessionID, {
            messageID: typeof body.messageID === "string" ? body.messageID : undefined,
            agent: typeof body.agent === "string" ? body.agent : undefined,
            model: isRecord(body.model) ? body.model : undefined,
            parts: body.parts,
          })
          publish(directory, "message.updated", { info: message.info })
          for (const part of message.parts) publish(directory, "message.part.updated", { part })
          publish(directory, "session.status", { sessionID, status: { type: "idle" } })
          return json(message)
        }
      }

      if (sessionRoute[1] === "todo" && request.method === "GET") return json([])

      if (sessionRoute[1] === "prompt_async" && request.method === "POST") {
        return runPromptAsync(directory, sessionID, await requestJson(request))
      }

      if (sessionRoute[1] === "schedule") {
        if (sessionRoute.length === 2) {
          if (request.method === "GET") return json(await store.listSchedules(directory, sessionID))
          if (request.method === "POST") {
            const body = await requestJson(request)
            const schedule = await store.createSchedule(directory, sessionID, {
              type: body.type === "cron" || body.type === "at" ? body.type : undefined,
              cron: typeof body.cron === "string" ? body.cron : undefined,
              at: typeof body.at === "string" || typeof body.at === "number" ? body.at : undefined,
              message: typeof body.message === "string" ? body.message : "",
            })
            publish(directory, "schedule.created", { sessionID, scheduleID: schedule.id })
            return json(schedule)
          }
        }
        if (sessionRoute.length === 3 && request.method === "DELETE") {
          const deleted = await store.deleteSchedule(directory, sessionID, sessionRoute[2]!)
          publish(directory, "schedule.deleted", { sessionID, scheduleID: sessionRoute[2] })
          return json(deleted)
        }
      }
    }

    return notFound()
  } catch (error) {
    if (error instanceof Response) return withCors(error)
    console.error(error)
    return json({ message: error instanceof Error ? error.message : String(error) }, { status: 500 })
  }
}

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
