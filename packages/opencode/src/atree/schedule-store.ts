import fs from "fs/promises"
import path from "path"
import { randomUUID } from "crypto"
import { ensureAtreeDirectoryStore } from "./directory-store"
import { ensureSessionPayloadFilesByID, readSessionStoresDeep, touchSessionStore, sessionJsonlPath } from "./session-store"
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

type SessionScheduleState = {
  version: 1
  updatedAt: number
  schedules: StoredSchedule[]
}

function publicScheduleProjection(input: { hasState: boolean; schedules: StoredSchedule[] }) {
  return { hasState: input.hasState, schedules: input.schedules }
}

function sessionStatePath(directory: string, sessionID: string) {
  return path.join(directory, ".agents", "atree", "sessions", sessionID, "schedule.json")
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

function sameSchedule(left: StoredSchedule | undefined, right: StoredSchedule | undefined) {
  return JSON.stringify(left) === JSON.stringify(right)
}

async function readSessionState(target: string) {
  try {
    const raw = await fs.readFile(target, "utf8")
    const parsed = JSON.parse(raw) as Partial<SessionScheduleState>
    return {
      hasState: true,
      updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : 0,
      schedules: Array.isArray(parsed.schedules) ? parsed.schedules.filter(isStoredSchedule) : [],
    }
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return { hasState: false, updatedAt: 0, schedules: [] as StoredSchedule[] }
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
  let hasState = false
  let updatedAt = 0

  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue
    let entry: Record<string, unknown>
    try {
      entry = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }

    const type = baseEventType(entry.type)
    const data = eventData(entry)
    const at = eventAt(entry, data)

    if (type === "schedule.created" && isStoredSchedule(data.schedule)) {
      if (data.schedule.sessionID !== sessionID) continue
      hasState = true
      if (at !== undefined) updatedAt = Math.max(updatedAt, at)
      schedules.set(data.schedule.id, data.schedule)
      continue
    }

    if (type === "schedule.ran") {
      const scheduleID = typeof data.scheduleID === "string" ? data.scheduleID : undefined
      const ranAt = typeof data.ranAt === "number" ? data.ranAt : undefined
      const status = data.status === "ran" || data.status === "skipped" ? data.status : undefined
      const nextRun = typeof data.nextRun === "number" || data.nextRun === null ? data.nextRun : undefined
      if (!scheduleID || ranAt === undefined || !status) continue
      const schedule = schedules.get(scheduleID)
      if (!schedule) continue
      hasState = true
      if (at !== undefined) updatedAt = Math.max(updatedAt, at)
      schedules.set(scheduleID, {
        ...schedule,
        lastRanAt: ranAt,
        lastRunStatus: status,
        ...(nextRun !== undefined ? { nextRun } : {}),
      })
      continue
    }

    if (type === "schedule.deleted") {
      const scheduleID = typeof data.scheduleID === "string" ? data.scheduleID : undefined
      if (!scheduleID) continue
      hasState = true
      if (at !== undefined) updatedAt = Math.max(updatedAt, at)
      schedules.delete(scheduleID)
    }
  }

  return { hasState, updatedAt, schedules: [...schedules.values()] }
}

async function writeAtomic(target: string, value: SessionScheduleState) {
  await fs.mkdir(path.dirname(target), { recursive: true })
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`)
  await fs.writeFile(temp, JSON.stringify(value, null, 2))
  await fs.rename(temp, target)
}

export async function writeSessionScheduleState(directory: string, sessionID: string, schedules: StoredSchedule[]) {
  await ensureAtreeDirectoryStore(directory)
  await ensureSessionPayloadFilesByID(directory, sessionID)
  const now = Date.now()
  const jsonlState = await readSessionJsonlProjection(directory, sessionID)
  const current = new Map(jsonlState.schedules.map((schedule) => [schedule.id, schedule]))
  const next = new Map(schedules.map((schedule) => [schedule.id, schedule]))
  const events: Record<string, unknown>[] = []
  for (const schedule of current.values()) {
    if (next.has(schedule.id)) continue
    events.push({
      version: 1,
      at: now,
      type: "schedule.deleted",
      scheduleID: schedule.id,
      sessionID,
      reason: "state-rewrite",
    })
  }
  for (const schedule of schedules) {
    if (sameSchedule(current.get(schedule.id), schedule)) continue
    events.push({
      version: 1,
      at: now,
      type: "schedule.created",
      schedule,
    })
  }
  if (events.length > 0) {
    await fs.appendFile(
      sessionJsonlPath(directory, sessionID),
      events.map((event) => JSON.stringify(event)).join("\n") + "\n",
    )
  }
  await writeAtomic(sessionStatePath(directory, sessionID), {
    version: 1,
    updatedAt: now,
    schedules,
  })
  await touchSessionStore(directory, sessionID as SessionID)
}

export async function readSessionScheduleProjection(directory: string, sessionID: string) {
  const jsonlState = await readSessionJsonlProjection(directory, sessionID)
  if (jsonlState.hasState) return publicScheduleProjection(jsonlState)

  const sessionState = await readSessionState(sessionStatePath(directory, sessionID))
  if (sessionState.hasState) return publicScheduleProjection(sessionState)

  return publicScheduleProjection(jsonlState)
}

export async function readSessionScheduleState(directory: string, sessionID: string) {
  return (await readSessionScheduleProjection(directory, sessionID)).schedules
}

export async function findSessionScheduleState(rootDirectory: string, scheduleID: string) {
  const root = await fs.realpath(rootDirectory)
  const sessions = await readSessionStoresDeep(root)
  let found:
    | {
        directory: string
        sessionID: string
        schedules: StoredSchedule[]
      }
    | undefined
  for (const session of sessions) {
    const schedules = await readSessionScheduleState(session.directory, session.id)
    if (!schedules.some((schedule) => schedule.id === scheduleID)) continue
    if (!found) {
      found = { directory: session.directory, sessionID: session.id, schedules }
      continue
    }
    if (found.directory !== session.directory || found.sessionID !== session.id) return
  }
  return found
}
