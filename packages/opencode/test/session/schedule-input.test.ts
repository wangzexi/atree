import { expect, it } from "bun:test"
import { buildScheduleCreateInput, parseScheduleAt, resolveScheduleType } from "../../src/session/schedule-input"

it("defaults schedule type to cron", () => {
  expect(resolveScheduleType({})).toBe("cron")
})

it("keeps explicit at type", () => {
  expect(resolveScheduleType({ type: "at" })).toBe("at")
})

it("resolves one-time schedule from at input", () => {
  const input = buildScheduleCreateInput({ type: "at", at: 1_700_000_000_000 })
  expect(input.kind).toBe("once")
  expect(input.runAt).toBe(1_700_000_000_000)
  expect(input.expression).toBeUndefined()
})

it("resolves recurring schedule from cron", () => {
  const input = buildScheduleCreateInput({
    type: "cron",
    cron: "*/5 * * * *",
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
