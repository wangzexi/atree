import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { appendSessionJsonl, writeSessionStore } from "../../src/atree/session-store"
import { readSessionInteractionState } from "../../src/atree/interaction-store"

const temps: string[] = []

async function tempdir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "atree-interaction-store-"))
  temps.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

describe("atree interaction store", () => {
  test("restores pending questions and permissions from nested directory sessions", async () => {
    const root = await tempdir()
    const nested = path.join(root, "projects", "inbox")
    await fs.mkdir(nested, { recursive: true })

    const session = {
      id: "ses_nested_interaction",
      slug: "nested-interaction",
      version: "test",
      projectID: "proj_nested_interaction",
      directory: nested,
      path: "projects/inbox",
      title: "Nested interaction",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 1, updated: 2 },
    } as any

    await writeSessionStore(session)
    await appendSessionJsonl(session, {
      type: "question.asked",
      question: {
        id: "que_nested_pending",
        sessionID: session.id,
        questions: [{ header: "Pick", question: "Choose one", options: [], custom: true }],
      },
    })
    await appendSessionJsonl(session, {
      type: "question.asked",
      question: {
        id: "que_nested_replied",
        sessionID: session.id,
        questions: [{ header: "Done", question: "Already answered", options: [], custom: true }],
      },
    })
    await appendSessionJsonl(session, {
      type: "question.replied",
      sessionID: session.id,
      requestID: "que_nested_replied",
      answers: [["ok"]],
    })
    await appendSessionJsonl(session, {
      type: "permission.asked",
      permission: {
        id: "per_nested_pending",
        sessionID: session.id,
        permission: "bash",
        patterns: ["*"],
        metadata: {},
        always: ["*"],
      },
    })
    await appendSessionJsonl(session, {
      type: "permission.asked",
      permission: {
        id: "per_nested_replied",
        sessionID: session.id,
        permission: "edit",
        patterns: ["src/*"],
        metadata: {},
        always: ["src/*"],
      },
    })
    await appendSessionJsonl(session, {
      type: "permission.replied",
      sessionID: session.id,
      requestID: "per_nested_replied",
      reply: "once",
    })

    const state = await readSessionInteractionState(root)

    expect(state.questions.map((item) => String(item.id))).toEqual(["que_nested_pending"])
    expect(state.permissions.map((item) => String(item.id))).toEqual(["per_nested_pending"])
  })
})
