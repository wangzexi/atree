import { expect, test } from "bun:test"
import path from "path"
import { readFile } from "fs/promises"
import { LLM, LLMEvent, Model } from "@opencode-ai/llm"
import * as OpenAIChat from "@opencode-ai/llm/protocols/openai-chat"
import { Config } from "@opencode-ai/core/config"
import { ConfigCompaction } from "@opencode-ai/core/config/compaction"
import { EventV2 } from "@opencode-ai/core/event"
import { Location } from "@opencode-ai/core/location"
import { ProjectV2 } from "@opencode-ai/core/project"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionCompaction } from "@opencode-ai/core/session/compaction"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionV2 } from "@opencode-ai/core/session"
import { writeSessionStore } from "@opencode-ai/core/atree/session-store"
import { DateTime, Effect, Stream } from "effect"
import { tmpdir } from "./fixture/tmpdir"

test("compaction describes tool media without embedding base64", () => {
  const base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB"
  const serialized = SessionCompaction.serializeToolContent([
    { type: "text", text: "Image read successfully" },
    {
      type: "file",
      uri: `data:image/png;base64,${base64}`,
      mime: "image/png",
      name: "pixel.png",
    },
  ])

  expect(serialized).toBe("Image read successfully\n[Attached image/png: pixel.png]")
  expect(serialized).not.toContain(base64)
})

test("compaction events are mirrored into file-backed session jsonl", async () => {
  await using tmp = await tmpdir()
  const session = SessionV2.Info.make({
    id: SessionV2.ID.make("ses_compaction_jsonl"),
    projectID: ProjectV2.ID.global,
    title: "Compaction jsonl",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: DateTime.makeUnsafe(1), updated: DateTime.makeUnsafe(1) },
    location: Location.Ref.make({ directory: AbsolutePath.make(tmp.path) }),
  })
  await writeSessionStore(session)
  const events = EventV2.Service.of({
    publish: (definition, data) =>
      Effect.sync(() => ({ id: EventV2.ID.create(), type: definition.type, data }) as EventV2.Payload<typeof definition>),
    subscribe: () => Stream.empty,
    all: () => Stream.empty,
    aggregateEvents: () => Stream.empty,
    sync: () => Effect.succeed(Effect.void),
    listen: () => Effect.succeed(Effect.void),
    beforeCommit: () => Effect.void,
    project: () => Effect.void,
    replay: () => Effect.void,
    replayAll: () => Effect.succeed(undefined),
    remove: () => Effect.void,
    claim: () => Effect.void,
  })
  const compaction = SessionCompaction.make({
    events,
    config: [
      new Config.Document({
        type: "document",
        info: new Config.Info({
          compaction: new ConfigCompaction.Info({
            keep: new ConfigCompaction.Keep({ tokens: 1_000 }),
          }),
        }),
      }),
    ],
    llm: {
      stream: () =>
        Stream.fromIterable([
          LLMEvent.textStart({ id: "summary" }),
          LLMEvent.textDelta({ id: "summary", text: "## Goal\n- Keep directory facts" }),
          LLMEvent.textEnd({ id: "summary" }),
        ]),
    },
  })
  const model = Model.make({
    id: "compact",
    provider: "test",
    route: OpenAIChat.route.with({ limits: { context: 100_000, output: 100 } }),
  })

  const compacted = await Effect.runPromise(
    compaction.compactAfterOverflow({
      sessionID: session.id,
      session,
      entries: [
        {
          seq: 1,
          message: new SessionMessage.User({
            id: SessionMessage.ID.make("msg_compaction_user"),
            type: "user",
            text: "A long conversation happened. ".repeat(2_000),
            time: { created: DateTime.makeUnsafe(2) },
          }),
        },
      ],
      model,
      request: LLM.request({ model, messages: [], tools: [] }),
    }),
  )

  expect(compacted).toBe(true)
  const entries = (await readFile(path.join(tmp.path, ".agents", "atree", "sessions", session.id, "session.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>)
  expect(entries.some((entry) => entry.type === "session.next.compaction.started")).toBe(true)
  expect(entries.some((entry) => entry.type === "session.next.compaction.ended" && entry.text === "## Goal\n- Keep directory facts")).toBe(true)
})
