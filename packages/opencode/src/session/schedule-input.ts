import { Schedule } from "./schedule"

export const SCHEDULE_KIND_LABELS = {
  cron: "cron",
  at: "at",
} as const

export type ScheduleType = (typeof SCHEDULE_KIND_LABELS)[keyof typeof SCHEDULE_KIND_LABELS]

export type RawScheduleInput = {
  type?: ScheduleType
  kind?: Schedule.Kind
  cron?: string
  expression?: string
  at?: number | string
  runAt?: number
}

export type ResolvedScheduleCreateInput = {
  kind: Schedule.Kind
  expression?: string
  runAt?: number
}

export function resolveScheduleType(input: RawScheduleInput): ScheduleType {
  if (input.type) return input.type
  return input.kind === "once" ? SCHEDULE_KIND_LABELS.at : SCHEDULE_KIND_LABELS.cron
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
  const runAt =
    type === "at"
      ? (() => {
          const atRunAt = parseScheduleAt(input.at)
          if (typeof atRunAt === "number" && Number.isFinite(atRunAt)) return atRunAt
          return parseScheduleAt(input.runAt)
        })()
      : undefined
  return {
    kind,
    expression: type === "cron" ? input.cron ?? input.expression : undefined,
    runAt,
  }
}
