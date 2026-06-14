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
  return {
    id: item.id,
    kind: item.kind ?? "recurring",
    expression: item.expression,
    runAt: item.runAt,
    nextRun: item.nextRun,
    nextRunAt: item.nextRun ?? item.runAt,
    message: item.message,
    lastRanAt: item.lastRanAt,
    lastRunStatus: item.lastRunStatus ?? null,
  }
}

export async function listSessionSchedules(current: ServerConnection.Any | null | undefined, sessionID: string) {
  if (!current) return [] as SessionScheduleSummary[]
  const url = new URL(`/session/${sessionID}/schedule`, current.http.url)
  const response = await fetch(url, { headers: sessionScheduleRequestHeaders(current) })
  if (!response.ok) throw new Error(`Failed to list schedules: ${response.status}`)

  const json = (await response.json()) as Array<SessionScheduleApiItem>
  return json.map((item) => ({
    ...normalizeSessionSchedule(item),
    runAt: asScheduleTime(item.runAt) ?? null,
    nextRun: asScheduleTime(item.nextRun) ?? null,
    nextRunAt: asScheduleTime(item.nextRun ?? item.runAt) ?? null,
    lastRanAt: asScheduleTime(item.lastRanAt) ?? null,
  }))
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

export async function deleteSessionSchedules(current: ServerConnection.Any | null | undefined, sessionID: string, schedules: Array<{ id: string }>) {
  await Promise.all(schedules.map((schedule) => deleteSessionSchedule(current, sessionID, schedule.id)))
}

