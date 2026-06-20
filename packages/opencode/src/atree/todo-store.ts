import fs from "fs/promises"
import path from "path"
import { randomUUID } from "crypto"
import { ensureAtreeDirectoryStore } from "./directory-store"
import { ensureSessionPayloadFilesByID, touchSessionStore } from "./session-store"
import type { SessionID } from "@/session/schema"

export type StoredTodo = {
  content: string
  status: string
  priority: string
}

type TodoState = {
  version: 1
  updatedAt: number
  sessions: Record<string, StoredTodo[]>
}

type SessionTodoState = {
  version: 1
  updatedAt: number
  todos: StoredTodo[]
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

async function readState(target: string): Promise<TodoState> {
  try {
    const raw = await fs.readFile(target, "utf8")
    const parsed = JSON.parse(raw) as Partial<TodoState>
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

async function readSessionState(target: string) {
  try {
    const raw = await fs.readFile(target, "utf8")
    const parsed = JSON.parse(raw) as Partial<SessionTodoState>
    return {
      hasState: true,
      todos: Array.isArray(parsed.todos) ? parsed.todos.filter(isStoredTodo) : [],
    }
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return { hasState: false, todos: [] as StoredTodo[] }
    }
    throw error
  }
}

async function writeAtomic(target: string, value: TodoState | SessionTodoState) {
  await fs.mkdir(path.dirname(target), { recursive: true })
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`)
  await fs.writeFile(temp, JSON.stringify(value, null, 2))
  await fs.rename(temp, target)
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

async function removeLegacySessionTodo(directory: string, sessionID: string) {
  const target = legacyStatePath(directory)
  const state = await readState(target)
  if (!Object.hasOwn(state.sessions, sessionID)) return
  delete state.sessions[sessionID]
  state.updatedAt = Date.now()
  await writeAtomic(target, state)
}

async function readSessionJsonlProjection(directory: string, sessionID: string) {
  const raw = await fs.readFile(sessionJsonlPath(directory, sessionID), "utf8").catch((error: unknown) => {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return ""
    throw error
  })
  let hasState = false
  let todos: StoredTodo[] = []

  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue
    let entry: Record<string, unknown>
    try {
      entry = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    if (entry.type !== "todo.updated") continue
    if (entry.sessionID !== sessionID) continue
    hasState = true
    todos = Array.isArray(entry.todos) ? entry.todos.filter(isStoredTodo) : []
  }

  return { hasState, todos }
}

export async function writeSessionTodoState(directory: string, sessionID: string, todos: StoredTodo[]) {
  await ensureAtreeDirectoryStore(directory)
  await ensureSessionPayloadFilesByID(directory, sessionID)
  await writeAtomic(sessionStatePath(directory, sessionID), {
    version: 1,
    updatedAt: Date.now(),
    todos,
  })
  await touchSessionStore(directory, sessionID as SessionID)
  await removeLegacySessionTodo(directory, sessionID)
}

export async function readSessionTodoProjection(directory: string, sessionID: string) {
  const sessionState = await readSessionState(sessionStatePath(directory, sessionID))
  if (sessionState.hasState) return sessionState

  const state = await readState(legacyStatePath(directory))
  if (!Object.hasOwn(state.sessions, sessionID)) return readSessionJsonlProjection(directory, sessionID)
  const todos = state.sessions[sessionID]
  return { hasState: true, todos: Array.isArray(todos) ? todos.filter(isStoredTodo) : [] }
}

export async function readSessionTodoState(directory: string, sessionID: string) {
  return (await readSessionTodoProjection(directory, sessionID)).todos
}
