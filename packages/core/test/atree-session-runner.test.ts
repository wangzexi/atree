import { describe, expect, test } from "bun:test"
import {
  LLMClient,
  LLMEvent,
  Model,
  type LLMClientShape,
  type LLMRequest,
} from "@opencode-ai/llm"
import * as OpenAIChat from "@opencode-ai/llm/protocols/openai-chat"
import { AgentV2 } from "@opencode-ai/core/agent"
import { ApplicationTools } from "@opencode-ai/core/tool/application-tools"
import { Config } from "@opencode-ai/core/config"
import { ConfigCompaction } from "@opencode-ai/core/config/compaction"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { Location } from "@opencode-ai/core/location"
import { ModelV2 } from "@opencode-ai/core/model"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { Project } from "@opencode-ai/core/project"
import { ReferenceGuidance } from "@opencode-ai/core/reference/guidance"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionInput } from "@opencode-ai/core/session/input"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { Prompt } from "@opencode-ai/core/session/prompt"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionRunCoordinator } from "@opencode-ai/core/session/run-coordinator"
import * as SessionRunnerLLM from "@opencode-ai/core/session/runner/llm"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SkillGuidance } from "@opencode-ai/core/skill/guidance"
import { SystemContext } from "@opencode-ai/core/system-context"
import { SystemContextRegistry } from "@opencode-ai/core/system-context/registry"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { Effect, Layer, Schema, Stream } from "effect"
import { mkdtemp } from "node:fs/promises"
import { access } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const database = Database.layerFromPath(":memory:")
const events = EventV2.layer.pipe(Layer.provide(database))
const projector = SessionProjector.layer.pipe(Layer.provide(events), Layer.provide(database))
const store = SessionStore.layer.pipe(Layer.provide(database))
const requests: LLMRequest[] = []
let responses: LLMEvent[][] = []

const client = Layer.succeed(
  LLMClient.Service,
  LLMClient.Service.of({
    prepare: () => Effect.die("unused"),
    stream: ((request: LLMRequest) => {
      requests.push(request)
      return Stream.fromIterable(responses.shift() ?? [])
    }) as unknown as LLMClientShape["stream"],
    generate: () => Effect.die("unused"),
  }),
)
const model = Model.make({ id: "fake-model", provider: "fake", route: OpenAIChat.route })
const models = SessionRunnerModel.layerWith(() => Effect.succeed(model))
const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: () => Effect.die("unused"),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)
const applications = ApplicationTools.layer
const registry = ToolRegistry.layer.pipe(
  Layer.provide(permission),
  Layer.provide(applications),
  Layer.provide(ToolOutputStore.defaultLayer),
)
const agents = AgentV2.layer
const systemContext = SystemContextRegistry.layer
const skillGuidance = Layer.mock(SkillGuidance.Service, { load: () => Effect.succeed(SystemContext.empty) })
const referenceGuidance = Layer.mock(ReferenceGuidance.Service, { load: () => Effect.succeed(SystemContext.empty) })
const config = Layer.succeed(
  Config.Service,
  Config.Service.of({
    entries: () =>
      Effect.succeed([
        new Config.Document({
          type: "document",
          info: new Config.Info({
            compaction: new ConfigCompaction.Info({
              buffer: 3_000,
              keep: new ConfigCompaction.Keep({ tokens: 1_000 }),
            }),
          }),
        }),
      ]),
  }),
)

const userTexts = (request: LLMRequest) =>
  request.messages.flatMap((message) =>
    message.role === "user"
      ? message.content.flatMap((content) => (content.type === "text" ? [content.text] : []))
      : [],
  )

describe("atree SessionRunner", () => {
  test("ignores stale sqlite queued inputs when a file-backed session has no pending prompts", async () => {
    const currentDirectory = AbsolutePath.make(await mkdtemp(path.join(os.tmpdir(), "atree-runner-")))
    const location = Layer.effect(
      Location.Service,
      Effect.gen(function* () {
        const project = yield* Project.Service
        const resolved = yield* project.resolve(currentDirectory)
        return Location.Service.of({
          directory: currentDirectory,
          project: { id: resolved.id, directory: resolved.directory },
          vcs: resolved.vcs,
        })
      }),
    ).pipe(Layer.provide(Project.defaultLayer))
    const runner = SessionRunnerLLM.layer.pipe(
      Layer.provide(database),
      Layer.provide(store),
      Layer.provide(events),
      Layer.provide(client),
      Layer.provide(registry),
      Layer.provide(models),
      Layer.provide(systemContext),
      Layer.provide(location),
      Layer.provide(agents),
      Layer.provide(skillGuidance),
      Layer.provide(referenceGuidance),
      Layer.provide(config),
    )
    const coordinator = SessionRunCoordinator.layer.pipe(Layer.provide(runner))
    const execution = Layer.effect(
      SessionExecution.Service,
      SessionRunCoordinator.Service.pipe(
        Effect.map((coordinator) =>
          SessionExecution.Service.of({
            resume: coordinator.run,
            wake: coordinator.wake,
            interrupt: coordinator.interrupt,
          }),
        ),
      ),
    ).pipe(Layer.provide(coordinator))
    const sessions = SessionV2.layer.pipe(
      Layer.provide(events),
      Layer.provide(database),
      Layer.provide(store),
      Layer.provide(Project.defaultLayer),
      Layer.provide(execution),
    )
    const layer = Layer.mergeAll(
      database,
      events,
      projector,
      store,
      client,
      permission,
      applications,
      agents,
      registry,
      models,
      systemContext,
      location,
      skillGuidance,
      referenceGuidance,
      config,
      runner,
      coordinator,
      execution,
      sessions,
    )

    await Effect.gen(function* () {
      requests.length = 0
      responses = [[LLMEvent.stepStart({ index: 0 }), LLMEvent.stepFinish({ index: 0, reason: "stop" }), LLMEvent.finish({ reason: "stop" })]]

      const sessionService = yield* SessionV2.Service
      const { db } = yield* Database.Service
      const session = yield* sessionService.create({
        id: SessionV2.ID.make("ses_atree_runner_file_backed"),
        location: Location.Ref.make({ directory: currentDirectory }),
      })
      const sessionMeta = path.join(currentDirectory, ".agents", "atree", "sessions", session.id, "meta.yaml")
      yield* Effect.promise(() => access(sessionMeta))
      expect(yield* SessionStore.Service.pipe(Effect.flatMap((service) => service.get(session.id, { directory: currentDirectory })))).toBeDefined()

      yield* sessionService.prompt({
        sessionID: session.id,
        prompt: new Prompt({ text: "Start working" }),
        resume: false,
        directory: currentDirectory,
      })

      yield* SessionInput.admit(db, yield* EventV2.Service, {
        id: SessionMessage.ID.create(),
        sessionID: session.id,
        prompt: new Prompt({ text: "stale sqlite queue" }),
        delivery: "queue",
      })

      yield* sessionService.resume(session.id, { directory: currentDirectory })

      expect(requests).toHaveLength(1)
      expect(userTexts(requests[0]!)).toEqual(["Start working"])
    })
      .pipe(Effect.scoped, Effect.provide(layer), Effect.runPromise)
  })
})
