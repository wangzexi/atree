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

function legacyStatePath(directory: string) {
  return path.join(directory, ".agents", "atree", "extensions", "todo", "state.json")
}

function sessionStatePath(directory: string, sessionID: string) {
  return path.join(directory, ".agents", "atree", "sessions", sessionID, "todo.json")
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

export async function writeSessionTodoState(directory: string, sessionID: string, todos: ReadonlyArray<StoredTodo>) {
  await ensureSessionPayloadFilesByID(directory, sessionID)
  await writeAtomic(sessionStatePath(directory, sessionID), {
    version: 1,
    updatedAt: Date.now(),
    todos: [...todos],
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
  try {
    const raw = await fs.readFile(sessionStatePath(directory, sessionID), "utf8")
    const parsed = JSON.parse(raw) as Partial<SessionTodoState>
    return {
      hasState: true,
      todos: Array.isArray(parsed.todos) ? parsed.todos.filter(isStoredTodo) : [],
    }
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      const state = await readLegacyState(legacyStatePath(directory))
      if (!Object.hasOwn(state.sessions, sessionID)) return { hasState: false, todos: [] as StoredTodo[] }
      const todos = state.sessions[sessionID]
      return { hasState: true, todos: Array.isArray(todos) ? todos.filter(isStoredTodo) : [] }
    }
    throw error
  }
}
