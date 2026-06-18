import fs from "fs/promises"
import path from "path"
import { ensureAtreeDirectoryStore } from "./directory-store"

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

function statePath(directory: string) {
  return path.join(directory, ".agents", "atree", "extensions", "todo", "state.json")
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

async function writeAtomic(target: string, value: TodoState) {
  await fs.mkdir(path.dirname(target), { recursive: true })
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`)
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

export async function writeSessionTodoState(directory: string, sessionID: string, todos: StoredTodo[]) {
  await ensureAtreeDirectoryStore(directory)
  const target = statePath(directory)
  const state = await readState(target)
  state.updatedAt = Date.now()
  state.sessions[sessionID] = todos
  await writeAtomic(target, state)
}

export async function readSessionTodoProjection(directory: string, sessionID: string) {
  const state = await readState(statePath(directory))
  if (!Object.hasOwn(state.sessions, sessionID)) return { hasState: false, todos: [] as StoredTodo[] }
  const todos = state.sessions[sessionID]
  return { hasState: true, todos: Array.isArray(todos) ? todos.filter(isStoredTodo) : [] }
}

export async function readSessionTodoState(directory: string, sessionID: string) {
  return (await readSessionTodoProjection(directory, sessionID)).todos
}
