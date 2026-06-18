import fs from "fs/promises"
import path from "path"

export type StoredSchedule = {
  id: string
  sessionID: string
  kind: "once" | "recurring"
  expression: string
  runAt: number | null
  message: string
  createdAt: number
  lastRanAt: number | null
  lastRunStatus: "ran" | "skipped" | null
  nextRun: number | null
}

type ScheduleState = {
  version: 1
  updatedAt: number
  sessions: Record<string, StoredSchedule[]>
}

function statePath(directory: string) {
  return path.join(directory, ".agents", "atree", "extensions", "schedule", "state.json")
}

async function readState(target: string): Promise<ScheduleState> {
  try {
    const raw = await fs.readFile(target, "utf8")
    const parsed = JSON.parse(raw) as Partial<ScheduleState>
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

async function writeAtomic(target: string, value: ScheduleState) {
  await fs.mkdir(path.dirname(target), { recursive: true })
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`)
  await fs.writeFile(temp, JSON.stringify(value, null, 2))
  await fs.rename(temp, target)
}

export async function writeSessionScheduleState(directory: string, sessionID: string, schedules: StoredSchedule[]) {
  const target = statePath(directory)
  const state = await readState(target)
  state.updatedAt = Date.now()
  if (schedules.length === 0) delete state.sessions[sessionID]
  else state.sessions[sessionID] = schedules
  await writeAtomic(target, state)
}

export async function readSessionScheduleState(directory: string, sessionID: string) {
  const state = await readState(statePath(directory))
  const schedules = state.sessions[sessionID]
  return Array.isArray(schedules) ? schedules : []
}
