import fs from "fs/promises"
import path from "path"
import { randomUUID } from "crypto"
import { ensureAtreeDirectoryStore } from "./directory-store"
import { ensureSessionPayloadFilesByID, touchSessionStore } from "./session-store"
import type { SessionID } from "@/session/schema"

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

type SessionScheduleState = {
  version: 1
  updatedAt: number
  schedules: StoredSchedule[]
}

function legacyStatePath(directory: string) {
  return path.join(directory, ".agents", "atree", "extensions", "schedule", "state.json")
}

function sessionStatePath(directory: string, sessionID: string) {
  return path.join(directory, ".agents", "atree", "sessions", sessionID, "schedule.json")
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

async function readSessionState(target: string) {
  try {
    const raw = await fs.readFile(target, "utf8")
    const parsed = JSON.parse(raw) as Partial<SessionScheduleState>
    return {
      hasState: true,
      schedules: Array.isArray(parsed.schedules) ? parsed.schedules : [],
    }
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return { hasState: false, schedules: [] as StoredSchedule[] }
    }
    throw error
  }
}

async function writeAtomic(target: string, value: ScheduleState | SessionScheduleState) {
  await fs.mkdir(path.dirname(target), { recursive: true })
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`)
  await fs.writeFile(temp, JSON.stringify(value, null, 2))
  await fs.rename(temp, target)
}

async function removeLegacySessionSchedule(directory: string, sessionID: string) {
  const target = legacyStatePath(directory)
  const state = await readState(target)
  if (!Object.hasOwn(state.sessions, sessionID)) return
  delete state.sessions[sessionID]
  state.updatedAt = Date.now()
  await writeAtomic(target, state)
}

export async function writeSessionScheduleState(directory: string, sessionID: string, schedules: StoredSchedule[]) {
  await ensureAtreeDirectoryStore(directory)
  await ensureSessionPayloadFilesByID(directory, sessionID)
  await writeAtomic(sessionStatePath(directory, sessionID), {
    version: 1,
    updatedAt: Date.now(),
    schedules,
  })
  await touchSessionStore(directory, sessionID as SessionID)
  await removeLegacySessionSchedule(directory, sessionID)
}

export async function readSessionScheduleState(directory: string, sessionID: string) {
  const sessionState = await readSessionState(sessionStatePath(directory, sessionID))
  if (sessionState.hasState) return sessionState.schedules

  const state = await readState(legacyStatePath(directory))
  const schedules = state.sessions[sessionID]
  return Array.isArray(schedules) ? schedules : []
}
