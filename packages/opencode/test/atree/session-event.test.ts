import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Effect } from "effect"
import { Global } from "@opencode-ai/core/global"
import {
  appendAtreeSessionEventBestEffort,
  appendAtreeSessionEventInDirectory,
} from "../../src/atree/session-event"
import { readSessionJsonlMessages, writeSessionStore } from "../../src/atree/session-store"
import { writeWorkspaceRoot } from "../../src/atree/state"

const temps: string[] = []

async function tempdir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "atree-session-event-"))
  temps.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

describe("atree session event routing", () => {
  test("writes explicit-directory events only to that directory's session store", async () => {
    const root = await tempdir()
    const source = path.join(root, "source")
    const target = path.join(source, "nested-target")
    await fs.mkdir(source, { recursive: true })
    await fs.mkdir(target, { recursive: true })

    const sessionID = "ses_event_overlap" as never
    await writeSessionStore({
      id: sessionID,
      slug: "event-overlap-source",
      version: "test",
      projectID: "proj_event_overlap",
      directory: source,
      path: ".",
      title: "Source session",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 1, updated: 1 },
    } as any)
    await writeSessionStore({
      id: sessionID,
      slug: "event-overlap-target",
      version: "test",
      projectID: "proj_event_overlap",
      directory: target,
      path: ".",
      title: "Target session",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 1, updated: 1 },
    } as any)

    const written = await Effect.runPromise(
      appendAtreeSessionEventInDirectory(source, sessionID, {
        type: "message.updated",
        message: {
          id: "msg_event_overlap",
          role: "user",
          time: { created: 2 },
        },
      }),
    )

    expect(written).toBe(true)
    expect(
      (await readSessionJsonlMessages({ id: sessionID, directory: source } as any)).map((item) =>
        String(item.info.id),
      ),
    ).toEqual(["msg_event_overlap"])
    expect(await readSessionJsonlMessages({ id: sessionID, directory: target } as any)).toEqual([])
  })

  test("best-effort directory writes do not fall through to a nested copied session when the explicit directory is missing", async () => {
    const data = await tempdir()
    const root = await tempdir()
    const source = path.join(root, "source")
    const target = path.join(source, "nested-target")
    const previousData = Global.Path.data
    ;(Global.Path as { data: string }).data = data
    try {
      await fs.mkdir(source, { recursive: true })
      await fs.mkdir(target, { recursive: true })
      await writeWorkspaceRoot(root)

      const sessionID = "ses_event_missing_explicit" as never
      await writeSessionStore({
        id: sessionID,
        slug: "event-missing-target",
        version: "test",
        projectID: "proj_event_missing",
        directory: target,
        path: ".",
        title: "Target session",
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: 1, updated: 1 },
      } as any)

      await Effect.runPromise(
        appendAtreeSessionEventBestEffort(source, sessionID, {
          type: "message.updated",
          message: {
            id: "msg_event_missing_explicit",
            role: "user",
            time: { created: 2 },
          },
        }),
      )

      expect(await readSessionJsonlMessages({ id: sessionID, directory: target } as any)).toEqual([])
    } finally {
      ;(Global.Path as { data: string }).data = previousData
    }
  })
})
