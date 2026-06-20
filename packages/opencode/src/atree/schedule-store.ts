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

const FindMaxDepth = 8
const FindMaxNodes = 2_000
const IgnoredDirectories = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  ".next",
  ".turbo",
  ".cache",
  "dist",
  "build",
])

function legacyStatePath(directory: string) {
  return path.join(directory, ".agents", "atree", "extensions", "schedule", "state.json")
}

function sessionStatePath(directory: string, sessionID: string) {
  return path.join(directory, ".agents", "atree", "sessions", sessionID, "schedule.json")
}

function sessionJsonlPath(directory: string, sessionID: string) {
  return path.join(directory, ".agents", "atree", "sessions", sessionID, "session.jsonl")
}

function baseEventType(value: unknown) {
  if (typeof value !== "string") return
  return value.replace(/\.\d+$/, "")
}

function isStoredSchedule(value: unknown): value is StoredSchedule {
  if (!value || typeof value !== "object") return false
  const schedule = value as Partial<StoredSchedule>
  return (
    typeof schedule.id === "string" &&
    typeof schedule.sessionID === "string" &&
    (schedule.kind === "once" || schedule.kind === "recurring") &&
    typeof schedule.expression === "string" &&
    (typeof schedule.runAt === "number" || schedule.runAt === null) &&
    typeof schedule.message === "string" &&
    typeof schedule.createdAt === "number" &&
    (typeof schedule.lastRanAt === "number" || schedule.lastRanAt === null) &&
    (schedule.lastRunStatus === "ran" || schedule.lastRunStatus === "skipped" || schedule.lastRunStatus === null) &&
    (typeof schedule.nextRun === "number" || schedule.nextRun === null)
  )
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

async function readSessionJsonlProjection(directory: string, sessionID: string) {
  const raw = await fs.readFile(sessionJsonlPath(directory, sessionID), "utf8").catch((error: unknown) => {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return ""
    throw error
  })
  const schedules = new Map<string, StoredSchedule>()

  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue
    let entry: Record<string, unknown>
    try {
      entry = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }

    const type = baseEventType(entry.type)

    if (type === "schedule.created" && isStoredSchedule(entry.schedule)) {
      if (entry.schedule.sessionID !== sessionID) continue
      schedules.set(entry.schedule.id, entry.schedule)
      continue
    }

    if (type === "schedule.ran") {
      const scheduleID = typeof entry.scheduleID === "string" ? entry.scheduleID : undefined
      const ranAt = typeof entry.ranAt === "number" ? entry.ranAt : undefined
      const status = entry.status === "ran" || entry.status === "skipped" ? entry.status : undefined
      const nextRun = typeof entry.nextRun === "number" || entry.nextRun === null ? entry.nextRun : undefined
      if (!scheduleID || ranAt === undefined || !status) continue
      const schedule = schedules.get(scheduleID)
      if (!schedule) continue
      schedules.set(scheduleID, {
        ...schedule,
        lastRanAt: ranAt,
        lastRunStatus: status,
        ...(nextRun !== undefined ? { nextRun } : {}),
      })
      continue
    }

    if (type === "schedule.deleted") {
      const scheduleID = typeof entry.scheduleID === "string" ? entry.scheduleID : undefined
      if (!scheduleID) continue
      schedules.delete(scheduleID)
    }
  }

  return [...schedules.values()]
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
  if (Array.isArray(schedules)) return schedules

  return readSessionJsonlProjection(directory, sessionID)
}

export async function findSessionScheduleState(rootDirectory: string, scheduleID: string) {
  const root = await fs.realpath(rootDirectory)
  const budget = { count: 0 }

  async function checkDirectory(directory: string) {
    const sessionsRoot = path.join(directory, ".agents", "atree", "sessions")
    const entries = await fs.readdir(sessionsRoot, { withFileTypes: true }).catch((error: unknown) => {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        (error.code === "ENOENT" || error.code === "EACCES")
      ) {
        return []
      }
      throw error
    })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const sessionID = entry.name
      const schedules = await readSessionScheduleState(directory, sessionID)
      if (schedules.some((schedule) => schedule.id === scheduleID)) return { directory, sessionID, schedules }
    }
  }

  async function walk(directory: string, depth: number): Promise<
    | {
        directory: string
        sessionID: string
        schedules: StoredSchedule[]
      }
    | undefined
  > {
    if (budget.count++ >= FindMaxNodes) return
    const found = await checkDirectory(directory)
    if (found) return found
    if (depth >= FindMaxDepth) return

    const entries = await fs.readdir(directory, { withFileTypes: true }).catch((error: unknown) => {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        (error.code === "ENOENT" || error.code === "EACCES")
      ) {
        return []
      }
      throw error
    })

    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (IgnoredDirectories.has(entry.name)) continue
      const result = await walk(path.join(directory, entry.name), depth + 1)
      if (result) return result
    }
  }

  return walk(root, 0)
}
