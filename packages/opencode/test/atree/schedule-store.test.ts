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
    await fs.readFile(path.join(directory, ".agents", "atree", "sessions", "ses_two", "schedule.json"), "utf8"),
  ) as {
    version: 1
    schedules: unknown[]
  }
}

async function readLegacyState(directory: string) {
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

    const meta = await fs.readFile(path.join(directory, ".agents", "atree", "meta.yaml"), "utf8")
    const state = await readState(directory)
    expect(meta).toContain("version: 1")
    expect(meta).toContain('source: "atree"')
    expect(state.version).toBe(1)
    expect(state.schedules).toHaveLength(1)
    expect(state.schedules[0]).toMatchObject({ id: "sch_two", sessionID: "ses_two" })
    expect(await readSessionScheduleState(directory, "ses_one")).toEqual([])
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

  test("creates the session payload skeleton when writing schedule state", async () => {
    const directory = await tempdir()
    await writeSessionScheduleState(directory, "ses_skeleton", [])

    const root = path.join(directory, ".agents", "atree", "sessions", "ses_skeleton")
    expect(await fs.readFile(path.join(root, "session.jsonl"), "utf8")).toBe("")
    expect((await fs.stat(path.join(root, "assets"))).isDirectory()).toBe(true)
    expect(JSON.parse(await fs.readFile(path.join(root, "schedule.json"), "utf8"))).toMatchObject({
      version: 1,
      schedules: [],
    })
  })

  test("falls back to legacy directory schedule state until the session is rewritten", async () => {
    const directory = await tempdir()
    const schedule = {
      id: "sch_legacy",
      sessionID: "ses_legacy",
      kind: "once" as const,
      expression: "",
      runAt: 2,
      message: "legacy check",
      createdAt: 1,
      lastRanAt: null,
      lastRunStatus: null,
      nextRun: 2,
    }

    await fs.mkdir(path.join(directory, ".agents", "atree", "extensions", "schedule"), { recursive: true })
    await fs.writeFile(
      path.join(directory, ".agents", "atree", "extensions", "schedule", "state.json"),
      JSON.stringify({ version: 1, updatedAt: 1, sessions: { ses_legacy: [schedule] } }),
    )

    expect(await readSessionScheduleState(directory, "ses_legacy")).toEqual([schedule])
    await writeSessionScheduleState(directory, "ses_legacy", [])
    expect(await readSessionScheduleState(directory, "ses_legacy")).toEqual([])
    expect((await readLegacyState(directory)).sessions.ses_legacy).toBeUndefined()
  })
})
