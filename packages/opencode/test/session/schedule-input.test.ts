import { expect, it } from "bun:test"
import {
  buildScheduleCreateInput,
  parseScheduleAt,
  resolveScheduleType,
} from "../../src/session/schedule-input"

it("resolveScheduleType prefers explicit type", () => {
  expect(resolveScheduleType({ type: "at", runAt: Date.now() })).toBe("at")
  expect(resolveScheduleType({ kind: "once", runAt: Date.now() })).toBe("at")
  expect(resolveScheduleType({})).toBe("cron")
})

it("buildScheduleCreateInput resolves at inputs with legacy fields", () => {
  const input = buildScheduleCreateInput({ kind: "once", runAt: 1_700_000_000_000, at: "ignored" })
  expect(input.kind).toBe("once")
  expect(input.runAt).toBe(1_700_000_000_000)
  expect(input.expression).toBeUndefined()
})

it("buildScheduleCreateInput resolves cron expressions", () => {
  const input = buildScheduleCreateInput({
    type: "cron",
    cron: "*/5 * * * *",
    expression: "0 0 * * *",
  })
  expect(input.kind).toBe("recurring")
  expect(input.expression).toBe("*/5 * * * *")
  expect(input.runAt).toBeUndefined()
})

it("parseScheduleAt supports ISO and milliseconds", () => {
  expect(parseScheduleAt(1700000000000)).toBe(1700000000000)
  expect(parseScheduleAt("2026-06-14T00:00:00+08:00")).toBeTypeOf("number")
  expect(parseScheduleAt("not-a-time")).toBeUndefined()
})
