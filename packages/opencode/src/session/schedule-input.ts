import { Schedule } from "./schedule"

export type ScheduleType = "cron" | "at"

export type RawScheduleInput = {
  type?: ScheduleType
  cron?: string
  at?: number | string
}

export type ResolvedScheduleCreateInput = {
  kind: Schedule.Kind
  expression?: string
  runAt?: number
}

export function resolveScheduleType(input: RawScheduleInput): ScheduleType {
  return input.type === "at" ? "at" : "cron"
}

export function parseScheduleAt(value: number | string | undefined): number | undefined {
  if (typeof value === "number") return value
  if (typeof value === "string") {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

export function buildScheduleCreateInput(input: RawScheduleInput): ResolvedScheduleCreateInput {
  const type = resolveScheduleType(input)
  const kind: Schedule.Kind = type === "at" ? "once" : "recurring"
  return {
    kind,
    expression: type === "cron" ? input.cron : undefined,
    runAt: type === "at" ? parseScheduleAt(input.at) : undefined,
  }
}
