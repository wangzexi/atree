import { describe, expect, test } from "bun:test"
import {
  extractSessionScheduleEventSessionID,
  isSessionScheduleEvent,
  normalizeSessionSchedule,
  sortSessionSchedulesByNextRun,
  type SessionScheduleApiItem,
} from "./session-schedule"

test("recognizes only schedule SSE events", () => {
  expect(isSessionScheduleEvent({ type: "schedule.created", properties: {} })).toBe(true)
  expect(isSessionScheduleEvent({ type: "schedule.deleted", properties: {} })).toBe(true)
  expect(isSessionScheduleEvent({ type: "schedule.ran", properties: {} })).toBe(true)
  expect(isSessionScheduleEvent({ type: "message.created", properties: {} })).toBe(false)
  expect(isSessionScheduleEvent(null)).toBe(false)
  expect(isSessionScheduleEvent(undefined)).toBe(false)
})

test("extracts session id from raw schedule events", () => {
  expect(
    extractSessionScheduleEventSessionID({
      type: "schedule.created",
      properties: { sessionID: "sess-1" },
    }),
  ).toBe("sess-1")
  expect(
    extractSessionScheduleEventSessionID({
      type: "schedule.ran",
      properties: { sessionID: "sess-2" },
    }),
  ).toBe("sess-2")
  expect(
    extractSessionScheduleEventSessionID({
      type: "message.created",
      properties: { sessionID: "sess-3" },
    }),
  ).toBeUndefined()
  expect(extractSessionScheduleEventSessionID({ type: "schedule.created" })).toBeUndefined()
})

describe("session schedule summary normalization", () => {
  test("normalizes null/number/string run times into numbers", () => {
    const normalized = normalizeSessionSchedule({
      id: "sch",
      kind: "once",
      sessionID: "sess",
      expression: "* * * * *",
      runAt: 1,
      nextRun: 2,
      message: "msg",
      createdAt: 1,
      lastRanAt: null,
      lastRunStatus: null,
    } satisfies SessionScheduleApiItem)

    expect(typeof normalized.runAt).toBe("number")
    expect(typeof normalized.nextRun).toBe("number")
    expect(typeof normalized.nextRunAt).toBe("number")
  })
})

describe("session schedule ordering", () => {
  test("sorts schedule list by next run ascending", () => {
    const sorted = sortSessionSchedulesByNextRun([
      { id: "later", kind: "once", expression: "", runAt: 100, nextRun: 300, nextRunAt: 300, message: "", lastRanAt: null, lastRunStatus: null },
      { id: "sooner", kind: "once", expression: "", runAt: 100, nextRun: 120, nextRunAt: 120, message: "", lastRanAt: null, lastRunStatus: null },
      { id: "none", kind: "once", expression: "", runAt: 100, nextRun: null, nextRunAt: null, message: "", lastRanAt: null, lastRunStatus: null },
    ])

    expect(sorted.map((item) => item.id)).toEqual(["sooner", "later", "none"])
  })
})
