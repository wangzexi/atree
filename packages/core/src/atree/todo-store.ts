import fs from "fs/promises"
import path from "path"
import { randomUUID } from "crypto"

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

function sessionStatePath(directory: string, sessionID: string) {
  return path.join(directory, ".agents", "atree", "sessions", sessionID, "todo.json")
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

export async function writeSessionTodoState(directory: string, sessionID: string, todos: ReadonlyArray<StoredTodo>) {
  const root = path.join(directory, ".agents", "atree", "sessions", sessionID)
  await fs.mkdir(path.join(root, "assets"), { recursive: true })
  await fs.writeFile(path.join(root, "session.jsonl"), "", { flag: "a" })
  await writeAtomic(sessionStatePath(directory, sessionID), {
    version: 1,
    updatedAt: Date.now(),
    todos: [...todos],
  })
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
      return { hasState: false, todos: [] as StoredTodo[] }
    }
    throw error
  }
}

