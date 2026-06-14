import { authTokenFromCredentials } from "@/utils/server"
import { type ServerConnection } from "@/context/server"

export type SessionScheduleApiItem = {
  id: string
  sessionID: string
  kind?: "once" | "recurring"
  expression: string
  runAt: number | null
  message: string
  createdAt: number
  lastRanAt: number | null
  lastRunStatus: "ran" | "skipped" | null
  nextRun: number | null
}

export type SessionScheduleSummary = {
  id: string
  kind: "once" | "recurring"
  expression: string
  runAt: number | null
  nextRun: number | null
  message: string
  nextRunAt: number | null
  lastRanAt: number | null
  lastRunStatus: "ran" | "skipped" | null
}

export type SessionUpdate = (input: {
  directory: string
  sessionID: string
  time: { archived: number }
}) => Promise<unknown>

export const SESSION_SCHEDULE_EVENTS = ["schedule.created", "schedule.deleted", "schedule.ran"] as const
export type SessionScheduleEventType = (typeof SESSION_SCHEDULE_EVENTS)[number]

export type SessionScheduleEvent = {
  type?: string
  properties?: Record<string, unknown>
}

export function isSessionScheduleEvent(event: unknown): event is { type: SessionScheduleEventType; properties?: Record<string, unknown> } {
  if (!event || typeof event !== "object") return false
  const typed = event as SessionScheduleEvent
  return SESSION_SCHEDULE_EVENTS.includes(typed.type as SessionScheduleEventType)
}

export function sessionScheduleRequestHeaders(current?: ServerConnection.Any | null) {
  const headers = new Headers()
  if (current?.http.password) {
    headers.set(
      "Authorization",
      `Basic ${authTokenFromCredentials({ username: current.http.username, password: current.http.password })}`,
    )
  }
  return headers
}

export function asScheduleTime(value: number | string | null | undefined) {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string") {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
}

export function normalizeSessionSchedule(item: SessionScheduleApiItem): SessionScheduleSummary {
  const runAt = asScheduleTime(item.runAt)
  const nextRun = asScheduleTime(item.nextRun)
  const nextRunAt = asScheduleTime(item.nextRun ?? item.runAt)
  return {
    id: item.id,
    kind: item.kind ?? "recurring",
    expression: item.expression,
    runAt: runAt ?? null,
    nextRun: nextRun ?? null,
    nextRunAt: nextRunAt ?? null,
    message: item.message,
    lastRanAt: asScheduleTime(item.lastRanAt) ?? null,
    lastRunStatus: item.lastRunStatus ?? null,
  }
}

export const sortSessionSchedulesByNextRun = (schedules: readonly SessionScheduleSummary[]) =>
  [...schedules].sort((a, b) => {
    const aNext = a.nextRunAt ?? Number.MAX_SAFE_INTEGER
    const bNext = b.nextRunAt ?? Number.MAX_SAFE_INTEGER
    return aNext - bNext
  })

export async function listSessionSchedules(current: ServerConnection.Any | null | undefined, sessionID: string) {
  if (!current) return [] as SessionScheduleSummary[]
  const url = new URL(`/session/${sessionID}/schedule`, current.http.url)
  const response = await fetch(url, { headers: sessionScheduleRequestHeaders(current) })
  if (!response.ok) throw new Error(`Failed to list schedules: ${response.status}`)

  const json = (await response.json()) as Array<SessionScheduleApiItem>
  return json.map((item) => normalizeSessionSchedule(item))
}

export async function deleteSessionSchedule(
  current: ServerConnection.Any | null | undefined,
  sessionID: string,
  scheduleID: string,
) {
  if (!current) return
  const url = new URL(`/session/${sessionID}/schedule/${scheduleID}`, current.http.url)
  const response = await fetch(url, { method: "DELETE", headers: sessionScheduleRequestHeaders(current) })
  if (!response.ok) throw new Error(`Failed to delete schedule: ${response.status}`)
}

export async function deleteSessionSchedules(
  current: ServerConnection.Any | null | undefined,
  sessionID: string,
  schedules: ReadonlyArray<Pick<SessionScheduleSummary, "id">>,
) {
  await Promise.all(schedules.map((schedule) => deleteSessionSchedule(current, sessionID, schedule.id)))
}

export async function clearSessionSchedules(
  current: ServerConnection.Any | null | undefined,
  sessionID: string,
  schedules?: ReadonlyArray<Pick<SessionScheduleSummary, "id">>,
) {
  const list = schedules ?? (await listSessionSchedules(current, sessionID))
  if (list.length === 0) return []
  await deleteSessionSchedules(current, sessionID, list)
  return list
}

export async function archiveSessionWithSchedules(input: {
  current: ServerConnection.Any | null | undefined
  directory: string
  sessionID: string
  archivedAt?: number
  schedules?: ReadonlyArray<Pick<SessionScheduleSummary, "id">>
  updateSession: SessionUpdate
}) {
  if (!input.current) {
    await input.updateSession({
      directory: input.directory,
      sessionID: input.sessionID,
      time: { archived: input.archivedAt ?? Date.now() },
    })
    return
  }

  await clearSessionSchedules(input.current, input.sessionID, input.schedules)
  await input.updateSession({
    directory: input.directory,
    sessionID: input.sessionID,
    time: { archived: input.archivedAt ?? Date.now() },
  })
}
