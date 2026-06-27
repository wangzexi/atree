import fs from "fs/promises"
import path from "path"
import { randomUUID } from "crypto"
import { ensureAtreeDirectoryStore } from "./directory-store"
import { ensureSessionPayloadFilesByID, touchSessionStore, sessionJsonlPath, baseEventType, eventData, eventAt } from "./session-store"
import { isRecord } from "@/util/record"
import type { SessionID } from "@/session/schema"

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

function publicTodoProjection(input: { hasState: boolean; todos: StoredTodo[] }) {
  return { hasState: input.hasState, todos: input.todos }
}

function sessionStatePath(directory: string, sessionID: string) {
  return path.join(directory, ".agents", "atree", "sessions", sessionID, "todo.json")
}






async function readSessionState(target: string) {
  try {
    const raw = await fs.readFile(target, "utf8")
    const parsed = JSON.parse(raw) as Partial<SessionTodoState>
    return {
      hasState: true,
      updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : 0,
      todos: Array.isArray(parsed.todos) ? parsed.todos.filter(isStoredTodo) : [],
    }
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return { hasState: false, updatedAt: 0, todos: [] as StoredTodo[] }
    }
    throw error
  }
}

async function writeAtomic(target: string, value: SessionTodoState) {
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

function sameTodos(left: ReadonlyArray<StoredTodo>, right: ReadonlyArray<StoredTodo>) {
  return JSON.stringify(left) === JSON.stringify(right)
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

export async function writeSessionTodoState(directory: string, sessionID: string, todos: StoredTodo[]) {
  await ensureAtreeDirectoryStore(directory)
  await ensureSessionPayloadFilesByID(directory, sessionID)
  const now = Date.now()
  const jsonlState = await readSessionJsonlProjection(directory, sessionID)
  if (!jsonlState.hasState || !sameTodos(jsonlState.todos, todos)) {
    await fs.appendFile(
      sessionJsonlPath(directory, sessionID),
      `${JSON.stringify({
        version: 1,
        at: now,
        type: "todo.updated",
        sessionID,
        todos,
      })}\n`,
    )
  }
  await writeAtomic(sessionStatePath(directory, sessionID), {
    version: 1,
    updatedAt: now,
    todos,
  })
  await touchSessionStore(directory, sessionID as SessionID)
}

export async function readSessionTodoProjection(directory: string, sessionID: string) {
  const jsonlState = await readSessionJsonlProjection(directory, sessionID)
  if (jsonlState.hasState) return publicTodoProjection(jsonlState)

  const sessionState = await readSessionState(sessionStatePath(directory, sessionID))
  if (sessionState.hasState) return publicTodoProjection(sessionState)

  return publicTodoProjection(jsonlState)
}

export async function readSessionTodoState(directory: string, sessionID: string) {
  return (await readSessionTodoProjection(directory, sessionID)).todos
}
