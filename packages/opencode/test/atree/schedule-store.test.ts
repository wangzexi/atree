import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { readSessionScheduleState, writeSessionScheduleState } from "../../src/atree/schedule-store"

const temps: string[] = []

async function tempdir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "atree-schedule-store-"))
  temps.push(dir)
  return dir
}

async function readState(directory: string) {
  return JSON.parse(
    await fs.readFile(path.join(directory, ".agents", "atree", "extensions", "schedule", "state.json"), "utf8"),
  ) as {
    version: 1
    sessions: Record<string, unknown[]>
  }
}

afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

describe("atree schedule store", () => {
  test("updates one session schedule entry without removing others", async () => {
    const directory = await tempdir()
    const schedule = {
      id: "sch_one",
      sessionID: "ses_one",
      kind: "once" as const,
      expression: "",
      runAt: 2,
      message: "check inbox",
      createdAt: 1,
      lastRanAt: null,
      lastRunStatus: null,
      nextRun: 2,
    }

    await writeSessionScheduleState(directory, "ses_one", [schedule])
    await writeSessionScheduleState(directory, "ses_two", [{ ...schedule, id: "sch_two", sessionID: "ses_two" }])
    await writeSessionScheduleState(directory, "ses_one", [])

    const state = await readState(directory)
    expect(state.version).toBe(1)
    expect(state.sessions.ses_one).toBeUndefined()
    expect(state.sessions.ses_two).toHaveLength(1)
    expect(state.sessions.ses_two[0]).toMatchObject({ id: "sch_two", sessionID: "ses_two" })
  })

  test("reads one session schedule state without mutating the file", async () => {
    const directory = await tempdir()
    const schedule = {
      id: "sch_read",
      sessionID: "ses_read",
      kind: "recurring" as const,
      expression: "0 * * * *",
      runAt: null,
      message: "hourly check",
      createdAt: 1,
      lastRanAt: null,
      lastRunStatus: null,
      nextRun: 2,
    }
    await writeSessionScheduleState(directory, "ses_read", [schedule])

    const schedules = await readSessionScheduleState(directory, "ses_read")
    expect(schedules).toEqual([schedule])
    expect(await readSessionScheduleState(directory, "missing")).toEqual([])
  })
})
