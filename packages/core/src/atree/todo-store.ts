import fs from "fs/promises"
import path from "path"
import { randomUUID } from "crypto"
import { ensureSessionPayloadFilesByID, touchSessionStore } from "./session-store"
import type { SessionSchema } from "../session/schema"

export type StoredTodo = {
  content: string
  status: string
  priority: string
}

type SessionTodoState = {
  version: 1
  updatedAt: number
  todos: StoredTodo[]
}

type LegacyTodoState = {
  version: 1
  updatedAt: number
  sessions: Record<string, StoredTodo[]>
}

function publicTodoProjection(input: { hasState: boolean; todos: StoredTodo[] }) {
  return { hasState: input.hasState, todos: input.todos }
}

function legacyStatePath(directory: string) {
  return path.join(directory, ".agents", "atree", "extensions", "todo", "state.json")
}

function sessionStatePath(directory: string, sessionID: string) {
  return path.join(directory, ".agents", "atree", "sessions", sessionID, "todo.json")
}

function sessionJsonlPath(directory: string, sessionID: string) {
  return path.join(directory, ".agents", "atree", "sessions", sessionID, "session.jsonl")
}

function baseEventType(value: unknown) {
  if (typeof value !== "string") return
  return value.replace(/\.\d+$/, "")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function eventData(entry: Record<string, unknown>) {
  return isRecord(entry.data) ? entry.data : entry
}

function eventAt(entry: Record<string, unknown>, data: Record<string, unknown>) {
  if (typeof entry.at === "number") return entry.at
  if (typeof data.at === "number") return data.at
  return
}

async function writeAtomic(target: string, value: SessionTodoState | LegacyTodoState) {
  await fs.mkdir(path.dirname(target), { recursive: true })
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`)
  await fs.writeFile(temp, JSON.stringify(value, null, 2))
  await fs.rename(temp, target)
}

async function readLegacyState(target: string): Promise<LegacyTodoState> {
  try {
    const raw = await fs.readFile(target, "utf8")
    const parsed = JSON.parse(raw) as Partial<LegacyTodoState>
    return {
      version: 1,
      updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : 0,
      sessions: parsed.sessions && typeof parsed.sessions === "object" ? parsed.sessions : {},
    }
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return { version: 1, updatedAt: 0, sessions: {} }
    }
    throw error
  }
}

async function readSessionJsonlProjection(directory: string, sessionID: string) {
  const raw = await fs.readFile(sessionJsonlPath(directory, sessionID), "utf8").catch((error: unknown) => {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return ""
    throw error
  })
  let hasState = false
  let updatedAt = 0
  let todos: StoredTodo[] = []

  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue
    let entry: Record<string, unknown>
    try {
      entry = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    const data = eventData(entry)
    if (baseEventType(entry.type) !== "todo.updated") continue
    if (data.sessionID !== sessionID) continue
    hasState = true
    const at = eventAt(entry, data)
    if (at !== undefined) updatedAt = Math.max(updatedAt, at)
    todos = Array.isArray(data.todos) ? data.todos.filter(isStoredTodo) : []
  }

  return { hasState, updatedAt, todos }
}

function isStoredTodo(value: unknown): value is StoredTodo {
  return (
    typeof value === "object" &&
    value !== null &&
    "content" in value &&
    "status" in value &&
    "priority" in value &&
    typeof value.content === "string" &&
    typeof value.status === "string" &&
    typeof value.priority === "string"
  )
}

function sameTodos(left: ReadonlyArray<StoredTodo>, right: ReadonlyArray<StoredTodo>) {
  return JSON.stringify(left) === JSON.stringify(right)
}

export async function writeSessionTodoState(directory: string, sessionID: string, todos: ReadonlyArray<StoredTodo>) {
  await ensureSessionPayloadFilesByID(directory, sessionID)
  const now = Date.now()
  const jsonlState = await readSessionJsonlProjection(directory, sessionID)
  const state = [...todos]
  if (!jsonlState.hasState || !sameTodos(jsonlState.todos, state)) {
    await fs.appendFile(
      sessionJsonlPath(directory, sessionID),
      `${JSON.stringify({
        version: 1,
        at: now,
        type: "todo.updated",
        sessionID,
        todos: state,
      })}\n`,
    )
  }
  await writeAtomic(sessionStatePath(directory, sessionID), {
    version: 1,
    updatedAt: now,
    todos: state,
  })
  await touchSessionStore(directory, sessionID as SessionSchema.ID)
  await removeLegacySessionTodo(directory, sessionID)
}

async function removeLegacySessionTodo(directory: string, sessionID: string) {
  const target = legacyStatePath(directory)
  const state = await readLegacyState(target)
  if (!Object.hasOwn(state.sessions, sessionID)) return
  delete state.sessions[sessionID]
  state.updatedAt = Date.now()
  await writeAtomic(target, state)
}

export async function readSessionTodoProjection(directory: string, sessionID: string) {
  const jsonlState = await readSessionJsonlProjection(directory, sessionID)
  if (jsonlState.hasState) return publicTodoProjection(jsonlState)

  try {
    const raw = await fs.readFile(sessionStatePath(directory, sessionID), "utf8")
    const parsed = JSON.parse(raw) as Partial<SessionTodoState>
    return publicTodoProjection({
      hasState: true,
      todos: Array.isArray(parsed.todos) ? parsed.todos.filter(isStoredTodo) : [],
    })
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      const state = await readLegacyState(legacyStatePath(directory))
      if (!Object.hasOwn(state.sessions, sessionID)) {
        return publicTodoProjection(jsonlState)
      }
      const todos = state.sessions[sessionID]
      return publicTodoProjection({
        hasState: true,
        todos: Array.isArray(todos) ? todos.filter(isStoredTodo) : [],
      })
    }
    throw error
  }
}
