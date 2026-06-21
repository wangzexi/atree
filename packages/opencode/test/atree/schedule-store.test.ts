import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { findSessionScheduleState, readSessionScheduleState, writeSessionScheduleState } from "../../src/atree/schedule-store"
import { appendSessionJsonl, readSessionStore, writeSessionStore } from "../../src/atree/session-store"

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

  test("touches session metadata when writing schedule state", async () => {
    const directory = await tempdir()
    await writeSessionStore({
      id: "ses_touch" as never,
      slug: "touch",
      version: "test",
      projectID: "proj_touch" as never,
      directory,
      title: "Touch",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 10, updated: 20 },
    })

    await writeSessionScheduleState(directory, "ses_touch", [])

    expect((await readSessionStore(directory, "ses_touch" as never))?.time.updated).toBeGreaterThan(20)
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

  test("replays schedule state from session jsonl when the projection file is missing", async () => {
    const directory = await tempdir()
    const schedule = {
      id: "sch_jsonl",
      sessionID: "ses_jsonl",
      kind: "recurring" as const,
      expression: "* * * * *",
      runAt: null,
      message: "recover from session log",
      createdAt: 1,
      lastRanAt: null,
      lastRunStatus: null,
      nextRun: 2,
    }
    await writeSessionStore({
      id: "ses_jsonl" as never,
      slug: "jsonl",
      version: "test",
      projectID: "proj_jsonl" as never,
      directory,
      title: "JSONL",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 1, updated: 1 },
    })
    const session = (await readSessionStore(directory, "ses_jsonl" as never))!
    await appendSessionJsonl(session, { type: "schedule.created", schedule })
    await appendSessionJsonl(session, {
      type: "schedule.ran",
      scheduleID: "sch_jsonl",
      sessionID: "ses_jsonl",
      status: "ran",
      ranAt: 3,
      nextRun: 4,
    })

    expect(await readSessionScheduleState(directory, "ses_jsonl")).toEqual([
      {
        ...schedule,
        lastRanAt: 3,
        lastRunStatus: "ran",
        nextRun: 4,
      },
    ])
    const realDirectory = await fs.realpath(directory)
    expect(await findSessionScheduleState(directory, "sch_jsonl")).toMatchObject({
      directory: realDirectory,
      sessionID: "ses_jsonl",
      schedules: [
        {
          id: "sch_jsonl",
          lastRanAt: 3,
          lastRunStatus: "ran",
          nextRun: 4,
        },
      ],
    })
  })

  test("replays deleted schedules from session jsonl as absent", async () => {
    const directory = await tempdir()
    const schedule = {
      id: "sch_jsonl_deleted",
      sessionID: "ses_jsonl_deleted",
      kind: "once" as const,
      expression: "",
      runAt: 2,
      message: "deleted from session log",
      createdAt: 1,
      lastRanAt: null,
      lastRunStatus: null,
      nextRun: 2,
    }
    await writeSessionStore({
      id: "ses_jsonl_deleted" as never,
      slug: "jsonl-deleted",
      version: "test",
      projectID: "proj_jsonl_deleted" as never,
      directory,
      title: "JSONL deleted",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 1, updated: 1 },
    })
    const session = (await readSessionStore(directory, "ses_jsonl_deleted" as never))!
    await appendSessionJsonl(session, { type: "schedule.created", schedule })
    await appendSessionJsonl(session, {
      type: "schedule.deleted",
      scheduleID: "sch_jsonl_deleted",
      sessionID: "ses_jsonl_deleted",
      reason: "deleted",
    })

    expect(await readSessionScheduleState(directory, "ses_jsonl_deleted")).toEqual([])
    expect(await findSessionScheduleState(directory, "sch_jsonl_deleted")).toBeUndefined()
  })

  test("replays versioned schedule events from session jsonl", async () => {
    const directory = await tempdir()
    const schedule = {
      id: "sch_jsonl_versioned",
      sessionID: "ses_jsonl_versioned",
      kind: "recurring" as const,
      expression: "*/5 * * * *",
      runAt: null,
      message: "recover from versioned session log",
      createdAt: 1,
      lastRanAt: null,
      lastRunStatus: null,
      nextRun: 2,
    }
    await writeSessionStore({
      id: "ses_jsonl_versioned" as never,
      slug: "jsonl-versioned",
      version: "test",
      projectID: "proj_jsonl_versioned" as never,
      directory,
      title: "JSONL versioned",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 1, updated: 1 },
    })
    const session = (await readSessionStore(directory, "ses_jsonl_versioned" as never))!
    await appendSessionJsonl(session, { type: "schedule.created.1", schedule })
    await appendSessionJsonl(session, {
      type: "schedule.ran.1",
      scheduleID: "sch_jsonl_versioned",
      sessionID: "ses_jsonl_versioned",
      status: "skipped",
      ranAt: 5,
    })

    expect(await readSessionScheduleState(directory, "ses_jsonl_versioned")).toEqual([
      {
        ...schedule,
        lastRanAt: 5,
        lastRunStatus: "skipped",
      },
    ])
  })

  test("replays nested schedule event data from session jsonl", async () => {
    const directory = await tempdir()
    const schedule = {
      id: "sch_jsonl_nested",
      sessionID: "ses_jsonl_nested",
      kind: "once" as const,
      expression: "",
      runAt: 2,
      message: "recover from nested event data",
      createdAt: 1,
      lastRanAt: null,
      lastRunStatus: null,
      nextRun: 2,
    }
    await writeSessionStore({
      id: "ses_jsonl_nested" as never,
      slug: "jsonl-nested",
      version: "test",
      projectID: "proj_jsonl_nested" as never,
      directory,
      title: "JSONL nested",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 1, updated: 1 },
    })
    const session = (await readSessionStore(directory, "ses_jsonl_nested" as never))!
    await appendSessionJsonl(session, {
      type: "schedule.created",
      at: 10,
      data: { schedule },
    })
    await appendSessionJsonl(session, {
      type: "schedule.ran",
      at: 20,
      data: {
        scheduleID: "sch_jsonl_nested",
        sessionID: "ses_jsonl_nested",
        status: "ran",
        ranAt: 3,
        nextRun: null,
      },
    })

    expect(await readSessionScheduleState(directory, "ses_jsonl_nested")).toEqual([
      {
        ...schedule,
        lastRanAt: 3,
        lastRunStatus: "ran",
        nextRun: null,
      },
    ])
  })
})
