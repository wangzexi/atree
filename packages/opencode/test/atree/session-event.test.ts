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
import { InstanceRef } from "../../src/effect/instance-ref"
import { withTmpdirInstance } from "../fixture/fixture"

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

  test("best-effort id routing prefers a nested session under the current instance tree before persisted-root copies", async () => {
    const data = await tempdir()
    const previousData = Global.Path.data
    ;(Global.Path as { data: string }).data = data
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const instance = yield* InstanceRef
          const instanceRoot = instance!.directory
          const root = path.dirname(instanceRoot)
          const nested = path.join(instanceRoot, "nested", "target")
          const sibling = path.join(root, "sibling-copy")
          const sessionID = "ses_event_instance_nested_preference" as never

          yield* Effect.promise(() => fs.mkdir(nested, { recursive: true }))
          yield* Effect.acquireRelease(
            Effect.promise(() => fs.mkdir(sibling, { recursive: true })),
            () => Effect.promise(() => fs.rm(sibling, { recursive: true, force: true })).pipe(Effect.ignore),
          )
          yield* Effect.promise(() => writeWorkspaceRoot(root))

          yield* Effect.promise(() =>
            writeSessionStore({
              id: sessionID,
              slug: "event-instance-nested-current",
              version: "test",
              projectID: "proj_event_instance_nested",
              directory: nested,
              path: "nested/target",
              title: "Nested instance session",
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              time: { created: 1, updated: 1 },
            } as any),
          )
          yield* Effect.promise(() =>
            writeSessionStore({
              id: sessionID,
              slug: "event-instance-nested-sibling",
              version: "test",
              projectID: "proj_event_instance_nested",
              directory: sibling,
              path: ".",
              title: "Sibling root session",
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              time: { created: 1, updated: 1 },
            } as any),
          )

          yield* appendAtreeSessionEventBestEffort(undefined, sessionID, {
            type: "message.updated",
            message: {
              id: "msg_event_instance_nested_preference",
              role: "user",
              time: { created: 2 },
            },
          })

          expect(
            (yield* Effect.promise(() => readSessionJsonlMessages({ id: sessionID, directory: nested } as any))).map(
              (item) => String(item.info.id),
            ),
          ).toEqual(["msg_event_instance_nested_preference"])
          expect(
            yield* Effect.promise(() => readSessionJsonlMessages({ id: sessionID, directory: sibling } as any)),
          ).toEqual([])
        })
          .pipe(withTmpdirInstance())
          .pipe(Effect.scoped),
      )
    } finally {
      ;(Global.Path as { data: string }).data = previousData
    }
  })
})
