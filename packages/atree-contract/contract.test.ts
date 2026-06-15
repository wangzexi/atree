import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { parseSessionEntries } from "../atree-runtime/node_modules/@mariozechner/pi-coding-agent"

const runContract = process.env.ATREE_CONTRACT === "1" ? describe : describe.skip
const runStorageContract = process.env.ATREE_STORAGE_CONTRACT === "1" ? describe : describe.skip
const isRealPiErrorContract = process.env.ATREE_PI_REAL_ERROR_CONTRACT === "1"
const isRealPiSuccessContract = process.env.ATREE_PI_REAL_SUCCESS_CONTRACT === "1"
const runPromptSuccessTest = isRealPiErrorContract || isRealPiSuccessContract ? test.skip : test

type Json = Record<string, unknown>

const baseUrl = (process.env.ATREE_CONTRACT_BASE_URL ?? "http://127.0.0.1:4096").replace(/\/+$/, "")
let directory = process.env.ATREE_CONTRACT_DIRECTORY
const cleanupDirectory = !directory
const authHeader = process.env.ATREE_CONTRACT_AUTH
const contractHome = process.env.ATREE_CONTRACT_HOME
const runHomeSkillContractTest = contractHome ? test : test.skip

async function exists(path: string) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function readFileUntil(path: string, match: (content: string) => boolean) {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    try {
      const content = await readFile(path, "utf8")
      if (match(content)) return content
    } catch {
      // Keep polling while the process under test writes the file.
    }
    await sleep(50)
  }
  throw new Error(`timed out waiting for ${path}`)
}

async function ensureTestDirectory() {
  if (!directory || !(await exists(directory))) directory = await mkdtemp(join(tmpdir(), "atree-contract-"))
  directory = await realpath(directory)
}

function headers(extra?: HeadersInit) {
  return {
    ...(authHeader ? { authorization: authHeader } : {}),
    ...extra,
  }
}

function url(path: string, query?: Record<string, string | number | boolean | undefined>) {
  const next = new URL(path, baseUrl)
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined) continue
    next.searchParams.set(key, String(value))
  }
  return next
}

async function json<T = Json>(
  path: string,
  options?: RequestInit & { query?: Record<string, string | number | boolean | undefined> },
): Promise<T> {
  const response = await fetch(url(path, options?.query), {
    ...options,
    headers: headers({
      accept: "application/json",
      ...(options?.body ? { "content-type": "application/json" } : {}),
      ...options?.headers,
    }),
  })
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`${options?.method ?? "GET"} ${path} failed: ${response.status} ${text}`)
  }
  return text.length > 0 ? (JSON.parse(text) as T) : (undefined as T)
}

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function sessionQuery(extra?: Record<string, string | number | boolean | undefined>) {
  if (!directory) throw new Error("contract directory is not initialized")
  return { directory, ...extra }
}

async function createSession() {
  return json<Json>("/session", {
    method: "POST",
    query: sessionQuery(),
  })
}

async function deleteSession(sessionID: string) {
  await json<boolean>(`/session/${sessionID}`, {
    method: "DELETE",
    query: sessionQuery(),
  }).catch(() => undefined)
}

async function writeManualSession(input: {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  archivedAt?: string | null
  icon?: string
  metadata?: Json
  schedule?: Json
  text?: string
}) {
  const sessionRoot = join(directory!, ".agents", "atree", "sessions", input.id)
  await mkdir(join(sessionRoot, "assets"), { recursive: true })
  await writeFile(
    join(sessionRoot, "meta.yaml"),
    `${JSON.stringify(
      {
        version: 1,
        id: input.id,
        title: input.title,
        ...(input.icon ? { icon: input.icon } : {}),
        ...(input.metadata ? { metadata: input.metadata } : {}),
        created_at: input.createdAt,
        updated_at: input.updatedAt,
        archived_at: input.archivedAt ?? null,
        ...(input.schedule ? { schedule: input.schedule } : {}),
      },
      null,
      2,
    )}\n`,
    "utf8",
  )
  await writeFile(
    join(sessionRoot, "session.jsonl"),
    [
      JSON.stringify({
        type: "session",
        version: 3,
        id: input.id,
        timestamp: input.createdAt,
        cwd: directory,
      }),
      ...(input.text
        ? [
            JSON.stringify({
              type: "message",
              id: `${input.id}_manual_user`,
              parentId: null,
              timestamp: input.updatedAt,
              message: {
                role: "user",
                content: [{ type: "text", text: input.text }],
                timestamp: new Date(input.updatedAt).getTime(),
              },
            }),
          ]
        : []),
    ].join("\n") + "\n",
    "utf8",
  )
}

async function writeManualYamlSession(input: {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  icon?: string
  schedule?: string[]
  text?: string
}) {
  const sessionRoot = join(directory!, ".agents", "atree", "sessions", input.id)
  await mkdir(join(sessionRoot, "assets"), { recursive: true })
  await writeFile(
    join(sessionRoot, "meta.yaml"),
    [
      "version: 1",
      `id: ${input.id}`,
      `title: ${input.title}`,
      ...(input.icon ? [`icon: ${input.icon}`] : []),
      `created_at: ${input.createdAt}`,
      `updated_at: ${input.updatedAt}`,
      "archived_at: null",
      ...(input.schedule ? ["", "schedule:", ...input.schedule.map((line) => `  ${line}`)] : []),
      "",
    ].join("\n"),
    "utf8",
  )
  await writeFile(
    join(sessionRoot, "session.jsonl"),
    [
      JSON.stringify({
        type: "session",
        version: 3,
        id: input.id,
        timestamp: input.createdAt,
        cwd: directory,
      }),
      ...(input.text
        ? [
            JSON.stringify({
              type: "message",
              id: `${input.id}_manual_yaml_user`,
              parentId: null,
              timestamp: input.updatedAt,
              message: {
                role: "user",
                content: [{ type: "text", text: input.text }],
                timestamp: new Date(input.updatedAt).getTime(),
              },
            }),
          ]
        : []),
    ].join("\n") + "\n",
    "utf8",
  )
}

async function installPiLifecycleExtension() {
  const extensionDir = join(directory!, ".pi", "extensions")
  const eventPath = join(directory!, ".agents", "atree-contract", "extension-events.jsonl")

  await mkdir(extensionDir, { recursive: true })
  await writeFile(
    join(extensionDir, "atree-contract-extension.ts"),
    [
      'import { appendFile, mkdir } from "node:fs/promises"',
      'import { join } from "node:path"',
      "",
      "async function record(cwd, value) {",
      '  const directory = join(cwd, ".agents", "atree-contract")',
      "  await mkdir(directory, { recursive: true })",
      '  await appendFile(join(directory, "extension-events.jsonl"), `${JSON.stringify(value)}\\n`, "utf8")',
      "}",
      "",
      "export default function(pi) {",
      '  pi.on("session_start", async (event, ctx) => {',
      '    await record(ctx.cwd, { event: "session_start", reason: event.reason })',
      "  })",
      '  pi.on("resources_discover", async (event, ctx) => {',
      '    await record(ctx.cwd, { event: "resources_discover", reason: event.reason })',
      "    return {}",
      "  })",
      '  pi.on("before_agent_start", async (event, ctx) => {',
      '    await record(ctx.cwd, { event: "before_agent_start", prompt: event.prompt })',
      "  })",
      "}",
      "",
    ].join("\n"),
    "utf8",
  )

  return eventPath
}

async function readLifecycleExtensionEvents(eventPath: string, prompt: string) {
  const events = await readFileUntil(
    eventPath,
    (content) =>
      content.includes('"event":"session_start"') &&
      content.includes('"event":"resources_discover"') &&
      content.includes('"event":"before_agent_start"'),
  )
  expect(events).toContain('"reason":"startup"')
  expect(events).toContain(`"prompt":"${prompt}"`)
  return events
}

async function cleanupPiLifecycleExtension() {
  await rm(join(directory!, ".pi"), { recursive: true, force: true })
  await rm(join(directory!, ".agents", "atree-contract"), { recursive: true, force: true })
}

type SseEvent = {
  directory?: string
  payload?: {
    id?: string
    type?: string
    properties?: Json
  }
}

function parseSseEvents(buffer: string) {
  const chunks = buffer.split("\n\n")
  const rest = chunks.pop() ?? ""
  const events: SseEvent[] = []

  for (const chunk of chunks) {
    const data = chunk
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.replace(/^data:\s*/, ""))
      .join("\n")
    if (!data) continue
    events.push(JSON.parse(data) as SseEvent)
  }

  return { events, rest }
}

async function withEventStream<T>(
  fn: (stream: { next: (match: (event: SseEvent) => boolean, timeoutMs?: number) => Promise<SseEvent> }) => Promise<T>,
) {
  const controller = new AbortController()
  const response = await fetch(url("/global/event"), {
    headers: headers({ accept: "text/event-stream" }),
    signal: controller.signal,
  })
  expect(response.ok).toBe(true)
  expect(response.body).toBeTruthy()

  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ""
  const pending: SseEvent[] = []

  async function next(match: (event: SseEvent) => boolean, timeoutMs = 5_000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const index = pending.findIndex(match)
      if (index !== -1) {
        const [event] = pending.splice(index, 1)
        return event
      }

      const remaining = deadline - Date.now()
      const read = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("timed out waiting for SSE event")), remaining),
        ),
      ])
      if (read.done) break
      buffer += read.value
      const parsed = parseSseEvents(buffer)
      buffer = parsed.rest
      pending.push(...parsed.events)
    }
    throw new Error("timed out waiting for SSE event")
  }

  try {
    return await fn({ next })
  } finally {
    controller.abort()
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

runContract("atree backend OpenCode-compatible contract", () => {
  beforeAll(async () => {
    await ensureTestDirectory()
    const health = await json<Json>("/global/health")
    expect(health.healthy).toBe(true)
  })

  afterAll(async () => {
    if (cleanupDirectory && directory) await rm(directory, { recursive: true, force: true })
  })

  test("serves path information for the selected directory", async () => {
    const path = await json<Json>("/path", { query: sessionQuery() })
    expect(path.directory).toBe(directory)
  })

  test("serves Pi as the default provider model and primary agent", async () => {
    const providers = await json<Json>("/provider", { query: sessionQuery() })
    expect(Array.isArray(providers.all)).toBe(true)
    expect(providers.connected).toEqual(["pi"])
    expect(providers.default).toEqual({ pi: "pi" })

    const provider = (providers.all as Json[]).find((item) => item.id === "pi")
    expect(provider?.name).toBe("Pi")
    expect(isRecord(provider?.models)).toBe(true)
    const model = (provider!.models as Json).pi
    expect(isRecord(model)).toBe(true)
    expect(model.id).toBe("pi")
    expect(model.tool_call).toBe(true)

    const agents = await json<Json[]>("/agent", { query: sessionQuery() })
    const agent = agents.find((item) => item.name === "pi")
    expect(agent?.mode).toBe("primary")
    expect(agent?.model).toEqual({ providerID: "pi", modelID: "pi" })
  })

  test("lists skills from the selected directory .agents/skills", async () => {
    const name = `contract-skill-${Date.now().toString(36)}`
    const skillRoot = join(directory!, ".agents", "skills", name)
    await mkdir(skillRoot, { recursive: true })
    await writeFile(
      join(skillRoot, "SKILL.md"),
      [
        "---",
        `name: ${name}`,
        "description: Contract skill discovered from the selected atree directory.",
        "---",
        "",
        "# Contract Skill",
        "",
        "Use this skill to verify atree directory skill discovery.",
        "",
      ].join("\n"),
      "utf8",
    )

    try {
      const skills = await json<Json[]>("/skill", { query: sessionQuery() })
      const skill = skills.find((item) => item.name === name)
      expect(skill?.description).toBe("Contract skill discovered from the selected atree directory.")
      expect(typeof skill?.location === "string" && skill.location.endsWith(`${name}/SKILL.md`)).toBe(true)
      expect(
        typeof skill?.content === "string" && skill.content.includes("verify atree directory skill discovery"),
      ).toBe(true)
    } finally {
      await rm(skillRoot, { recursive: true, force: true })
    }
  })

  test("lists skills from ancestor .agents/skills when a child directory is selected", async () => {
    const name = `contract-ancestor-skill-${Date.now().toString(36)}`
    const childDirectory = join(directory!, "child-workspace")
    const skillRoot = join(directory!, ".agents", "skills", name)
    await mkdir(childDirectory, { recursive: true })
    await mkdir(skillRoot, { recursive: true })
    await writeFile(
      join(skillRoot, "SKILL.md"),
      [
        "---",
        `name: ${name}`,
        "description: Contract skill discovered from an ancestor atree directory.",
        "---",
        "",
        "# Ancestor Contract Skill",
        "",
        "Use this skill to verify ancestor directory skill discovery.",
        "",
      ].join("\n"),
      "utf8",
    )

    try {
      const skills = await json<Json[]>("/skill", { query: { directory: childDirectory } })
      const skill = skills.find((item) => item.name === name)
      expect(skill?.description).toBe("Contract skill discovered from an ancestor atree directory.")
      expect(typeof skill?.location === "string" && skill.location.endsWith(`${name}/SKILL.md`)).toBe(true)
      expect(
        typeof skill?.content === "string" && skill.content.includes("verify ancestor directory skill discovery"),
      ).toBe(true)
    } finally {
      await rm(skillRoot, { recursive: true, force: true })
      await rm(childDirectory, { recursive: true, force: true })
    }
  })

  runHomeSkillContractTest("lists skills from user home .agents/skills", async () => {
    const name = `contract-home-skill-${Date.now().toString(36)}`
    const skillRoot = join(contractHome!, ".agents", "skills", name)
    await mkdir(skillRoot, { recursive: true })
    await writeFile(
      join(skillRoot, "SKILL.md"),
      [
        "---",
        `name: ${name}`,
        "description: Contract skill discovered from the atree user home directory.",
        "---",
        "",
        "# Home Contract Skill",
        "",
        "Use this skill to verify user home skill discovery.",
        "",
      ].join("\n"),
      "utf8",
    )

    try {
      const skills = await json<Json[]>("/skill", { query: sessionQuery() })
      const skill = skills.find((item) => item.name === name)
      expect(skill?.description).toBe("Contract skill discovered from the atree user home directory.")
      expect(typeof skill?.location === "string" && skill.location.endsWith(`${name}/SKILL.md`)).toBe(true)
      expect(typeof skill?.content === "string" && skill.content.includes("verify user home skill discovery")).toBe(
        true,
      )
    } finally {
      await rm(skillRoot, { recursive: true, force: true })
    }
  })

  test("creates, lists, updates, reads, and deletes a session", async () => {
    const created = await createSession()
    const sessionID = String(created.id)
    expect(sessionID).toStartWith("ses_")
    expect(created.directory).toBe(directory)

    try {
      const title = "Contract session"
      const updated = await json<Json>(`/session/${sessionID}`, {
        method: "PATCH",
        query: sessionQuery(),
        body: JSON.stringify({
          title,
          metadata: {
            atree: {
              emoji: "🧪",
            },
          },
        }),
      })
      expect(updated.title).toBe(title)
      expect(isRecord(updated.metadata)).toBe(true)

      const list = await json<Json[]>("/session", { query: sessionQuery({ roots: true, limit: 50 }) })
      expect(list.some((session) => session.id === sessionID)).toBe(true)

      const messages = await json<unknown[]>(`/session/${sessionID}/message`, { query: sessionQuery() })
      expect(Array.isArray(messages)).toBe(true)
    } finally {
      await deleteSession(sessionID)
    }
  })

  test("creates and deletes one scheduled message per session", async () => {
    const created = await createSession()
    const sessionID = String(created.id)
    const runAt = Date.now() + 10 * 60_000

    try {
      const schedule = await json<Json>(`/session/${sessionID}/schedule`, {
        method: "POST",
        query: sessionQuery(),
        body: JSON.stringify({
          type: "at",
          at: runAt,
          message: "contract scheduled message",
        }),
      })

      expect(schedule.sessionID).toBe(sessionID)
      expect(schedule.kind).toBe("once")
      expect(schedule.message).toBe("contract scheduled message")

      if (process.env.ATREE_STORAGE_CONTRACT === "1") {
        const meta = await readFile(join(directory!, ".agents", "atree", "sessions", sessionID, "meta.yaml"), "utf8")
        const storedRunAt = meta.match(/^\s*run_at:\s*(.+)$/m)?.[1]?.trim()
        expect(storedRunAt).toBe(new Date(runAt).toISOString())
        expect(storedRunAt).not.toMatch(/^\d+$/)
      }

      const schedules = await json<Json[]>(`/session/${sessionID}/schedule`, { query: sessionQuery() })
      expect(schedules.map((item) => item.id)).toContain(schedule.id)

      const deleted = await json<boolean>(`/session/${sessionID}/schedule/${String(schedule.id)}`, {
        method: "DELETE",
        query: sessionQuery(),
      })
      expect(deleted).toBe(true)

      const afterDelete = await json<Json[]>(`/session/${sessionID}/schedule`, { query: sessionQuery() })
      expect(afterDelete.map((item) => item.id)).not.toContain(schedule.id)
    } finally {
      await deleteSession(sessionID)
    }
  })

  test("rejects a second scheduled message until the existing one is deleted", async () => {
    const created = await createSession()
    const sessionID = String(created.id)

    try {
      const first = await json<Json>(`/session/${sessionID}/schedule`, {
        method: "POST",
        query: sessionQuery(),
        body: JSON.stringify({
          type: "at",
          at: Date.now() + 10 * 60_000,
          message: "first scheduled message",
        }),
      })
      expect(first.message).toBe("first scheduled message")

      const duplicate = await fetch(url(`/session/${sessionID}/schedule`, sessionQuery()), {
        method: "POST",
        headers: headers({
          accept: "application/json",
          "content-type": "application/json",
        }),
        body: JSON.stringify({
          type: "cron",
          cron: "0 9 * * *",
          message: "second scheduled message",
        }),
      })
      expect(duplicate.status).toBe(409)
      expect(await duplicate.text()).toContain("Session already has a schedule")

      const schedules = await json<Json[]>(`/session/${sessionID}/schedule`, { query: sessionQuery() })
      expect(schedules).toHaveLength(1)
      expect(schedules[0]?.id).toBe(first.id)
      expect(schedules[0]?.message).toBe("first scheduled message")
    } finally {
      await deleteSession(sessionID)
    }
  })

  runPromptSuccessTest("persists prompt_async user messages immediately", async () => {
    const created = await createSession()
    const sessionID = String(created.id)
    const text = "contract prompt_async user message"

    try {
      await json<unknown>(`/session/${sessionID}/prompt_async`, {
        method: "POST",
        query: sessionQuery(),
        body: JSON.stringify({
          parts: [{ type: "text", text }],
        }),
      })

      const messages = await json<Json[]>(`/session/${sessionID}/message`, { query: sessionQuery() })
      const userMessage = messages.find((message) => {
        if (!isRecord(message.info) || message.info.role !== "user") return false
        if (!Array.isArray(message.parts)) return false
        return message.parts.some((part) => isRecord(part) && part.type === "text" && part.text === text)
      })
      expect(userMessage).toBeTruthy()
    } finally {
      await deleteSession(sessionID)
    }
  })

  test("emits global SSE events for session changes", async () => {
    await withEventStream(async (stream) => {
      await stream.next((event) => event.payload?.type === "server.connected")

      const created = await createSession()
      const sessionID = String(created.id)
      try {
        const event = await stream.next(
          (item) =>
            item.directory === directory &&
            item.payload?.type === "session.created" &&
            item.payload.properties?.info &&
            isRecord(item.payload.properties.info) &&
            item.payload.properties.info.id === sessionID,
        )
        expect(event.payload?.type).toBe("session.created")
      } finally {
        await deleteSession(sessionID)
      }
    })
  })
})

runStorageContract("atree directory storage contract", () => {
  beforeAll(async () => {
    await ensureTestDirectory()
    const health = await json<Json>("/global/health")
    expect(health.healthy).toBe(true)
  })

  afterAll(async () => {
    if (cleanupDirectory && directory) await rm(directory, { recursive: true, force: true })
  })

  test("stores each session as a self-contained .agents/atree session directory", async () => {
    const created = await createSession()
    const sessionID = String(created.id)

    try {
      const root = join(directory!, ".agents")
      const atree = join(root, "atree")
      const sessionRoot = join(atree, "sessions", sessionID)

      await expect(stat(join(root, "skills"))).resolves.toBeTruthy()
      await expect(stat(join(atree, "meta.yaml"))).resolves.toBeTruthy()
      await expect(stat(join(sessionRoot, "meta.yaml"))).resolves.toBeTruthy()
      await expect(stat(join(sessionRoot, "assets"))).resolves.toBeTruthy()

      const rootMeta = await readFile(join(atree, "meta.yaml"), "utf8")
      const sessionMeta = await readFile(join(sessionRoot, "meta.yaml"), "utf8")
      expect(rootMeta.trim().startsWith("{")).toBe(false)
      expect(sessionMeta.trim().startsWith("{")).toBe(false)
      expect(rootMeta).toContain("version: 1")
      expect(sessionMeta).toContain(`id: ${sessionID}`)
      expect(sessionMeta).toContain("archived_at: null")

      const sessionJsonl = await readFile(join(sessionRoot, "session.jsonl"), "utf8")
      const [headerLine] = sessionJsonl.trim().split("\n")
      const header = JSON.parse(headerLine!) as Json
      expect(header.type).toBe("session")
      expect(header.version).toBe(3)
      expect(header.id).toBe(sessionID)
      expect(header.cwd).toBe(directory)
    } finally {
      await deleteSession(sessionID)
    }
  })

  test("keeps atree private state under .agents/atree without root session inventory", async () => {
    const created = await createSession()
    const sessionID = String(created.id)

    try {
      await json<Json>(`/session/${sessionID}`, {
        method: "PATCH",
        query: sessionQuery(),
        body: JSON.stringify({
          title: "Boundary contract session",
          metadata: {
            atree: {
              emoji: "🧭",
            },
          },
        }),
      })
      await json<Json>(`/session/${sessionID}/schedule`, {
        method: "POST",
        query: sessionQuery(),
        body: JSON.stringify({
          type: "at",
          at: Date.now() + 30 * 60_000,
          message: "boundary contract scheduled message",
        }),
      })

      const agentsRoot = join(directory!, ".agents")
      const agentsEntries = (await readdir(agentsRoot)).sort()
      expect(agentsEntries).toEqual(["atree", "skills"])

      const atreeRoot = join(agentsRoot, "atree")
      const atreeEntries = (await readdir(atreeRoot)).sort()
      expect(atreeEntries).toEqual(["meta.yaml", "sessions"])

      const rootMeta = await readFile(join(atreeRoot, "meta.yaml"), "utf8")
      expect(rootMeta).toContain("version: 1")
      expect(rootMeta).not.toContain(sessionID)
      expect(rootMeta).not.toContain("sessions:")
      expect(rootMeta).not.toContain("schedule:")
      expect(rootMeta).not.toContain("archived_at:")
      expect(rootMeta).not.toContain("created_at:")
      expect(rootMeta).not.toContain("updated_at:")
      expect(rootMeta).not.toContain("icon:")

      const sessionMeta = await readFile(join(atreeRoot, "sessions", sessionID, "meta.yaml"), "utf8")
      expect(sessionMeta).toContain(`id: ${sessionID}`)
      expect(sessionMeta).toContain("title: Boundary contract session")
      expect(sessionMeta).toContain("icon: 🧭")
      expect(sessionMeta).toContain("schedule:")
    } finally {
      await deleteSession(sessionID)
    }
  })

  runPromptSuccessTest("does not create OpenCode private state in a fresh workspace root", async () => {
    const workspace = join(directory!, `root-boundary-${Date.now().toString(36)}`)
    await mkdir(workspace, { recursive: true })
    let sessionID = ""

    try {
      const created = await json<Json>("/session", {
        method: "POST",
        query: { directory: workspace },
      })
      sessionID = String(created.id)

      await json<Json>(`/session/${sessionID}/schedule`, {
        method: "POST",
        query: { directory: workspace },
        body: JSON.stringify({
          type: "at",
          at: Date.now() + 30 * 60_000,
          message: "root boundary scheduled message",
        }),
      })

      await json<unknown>(`/session/${sessionID}/prompt_async`, {
        method: "POST",
        query: { directory: workspace },
        body: JSON.stringify({
          parts: [{ type: "text", text: "root boundary prompt message" }],
        }),
      })

      const hiddenEntries = (await readdir(workspace)).filter((entry) => entry.startsWith(".")).sort()
      expect(hiddenEntries).toEqual([".agents"])
      expect((await readdir(join(workspace, ".agents"))).sort()).toEqual(["atree", "skills"])
      expect(await exists(join(workspace, ".opencode"))).toBe(false)
      expect(await exists(join(workspace, ".pi"))).toBe(false)
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  test("derives session inventory by scanning session directories instead of root meta", async () => {
    const sessionID = `ses_contract_scanned_${Date.now().toString(36)}`
    const fakeSessionID = `ses_contract_stale_${Date.now().toString(36)}`
    const now = new Date().toISOString()

    try {
      await writeManualYamlSession({
        id: sessionID,
        title: "Scanned session directory",
        createdAt: now,
        updatedAt: now,
        icon: "🗂️",
        text: "session restored from scanned session directory",
      })
      await writeFile(
        join(directory!, ".agents", "atree", "meta.yaml"),
        [
          "version: 1",
          "title: stale root inventory",
          "sessions:",
          `  - id: ${fakeSessionID}`,
          "    title: Stale session that must not appear",
          "schedule:",
          "  id: sch_root_stale",
          "  kind: at",
          `  run_at: ${new Date(Date.now() + 60_000).toISOString()}`,
          "  message: stale root schedule that must not appear",
          "",
        ].join("\n"),
        "utf8",
      )

      const list = await json<Json[]>("/session", {
        query: sessionQuery({ roots: true, includeArchived: true, limit: 100 }),
      })
      const restored = list.find((session) => session.id === sessionID)
      const stale = list.find((session) => session.id === fakeSessionID)
      expect(restored?.title).toBe("Scanned session directory")
      expect(isRecord(restored?.metadata)).toBe(true)
      expect(isRecord(restored?.metadata.atree)).toBe(true)
      expect(restored.metadata.atree.emoji).toBe("🗂️")
      expect(stale).toBeUndefined()

      const messages = await json<Json[]>(`/session/${sessionID}/message`, { query: sessionQuery() })
      const userText = messages.find((message) => {
        if (!isRecord(message.info) || message.info.role !== "user") return false
        if (!Array.isArray(message.parts)) return false
        return message.parts.some(
          (part) =>
            isRecord(part) && part.type === "text" && part.text === "session restored from scanned session directory",
        )
      })
      expect(userText).toBeTruthy()
    } finally {
      await deleteSession(sessionID)
      await rm(join(directory!, ".agents", "atree", "sessions", fakeSessionID), { recursive: true, force: true })
    }
  })

  test("rebuilds session lists and messages from an existing .agents/atree session directory", async () => {
    const sessionID = `ses_contract_manual_${Date.now().toString(36)}`
    const now = new Date().toISOString()
    const text = "manual directory source of truth message"

    try {
      await writeManualSession({
        id: sessionID,
        title: "Manual source session",
        createdAt: now,
        updatedAt: now,
        text,
      })

      const list = await json<Json[]>("/session", { query: sessionQuery({ roots: true, limit: 50 }) })
      const restored = list.find((session) => session.id === sessionID)
      expect(restored?.title).toBe("Manual source session")

      const messages = await json<Json[]>(`/session/${sessionID}/message`, { query: sessionQuery() })
      const userMessage = messages.find((message) => {
        if (!isRecord(message.info) || message.info.role !== "user") return false
        if (!Array.isArray(message.parts)) return false
        return message.parts.some((part) => isRecord(part) && part.type === "text" && part.text === text)
      })
      expect(userMessage).toBeTruthy()
    } finally {
      await deleteSession(sessionID)
    }
  })

  test("restores sessions from human-editable YAML meta files", async () => {
    const sessionID = `ses_contract_manual_yaml_${Date.now().toString(36)}`
    const now = new Date().toISOString()
    const text = "manual yaml source of truth message"

    try {
      await writeManualYamlSession({
        id: sessionID,
        title: "Manual YAML source session",
        createdAt: now,
        updatedAt: now,
        icon: "🌿",
        text,
      })

      const restored = await json<Json>(`/session/${sessionID}`, { query: sessionQuery() })
      expect(restored.title).toBe("Manual YAML source session")
      expect(isRecord(restored.metadata)).toBe(true)
      expect(isRecord(restored.metadata.atree)).toBe(true)
      expect(restored.metadata.atree.emoji).toBe("🌿")

      const messages = await json<Json[]>(`/session/${sessionID}/message`, { query: sessionQuery() })
      const userMessage = messages.find((message) => {
        if (!isRecord(message.info) || message.info.role !== "user") return false
        if (!Array.isArray(message.parts)) return false
        return message.parts.some((part) => isRecord(part) && part.type === "text" && part.text === text)
      })
      expect(userMessage).toBeTruthy()
    } finally {
      await deleteSession(sessionID)
    }
  })

  test("restores at schedules from human-editable ISO YAML meta files", async () => {
    const sessionID = `ses_contract_manual_yaml_schedule_${Date.now().toString(36)}`
    const scheduleID = `sch_contract_manual_yaml_${Date.now().toString(36)}`
    const now = new Date().toISOString()
    const runAt = Date.now() + 15 * 60_000
    const runAtIso = new Date(runAt).toISOString()

    try {
      await writeManualYamlSession({
        id: sessionID,
        title: "Manual YAML scheduled session",
        createdAt: now,
        updatedAt: now,
        schedule: [
          `id: ${scheduleID}`,
          "kind: at",
          `run_at: ${runAtIso}`,
          "message: manual yaml scheduled message",
          `created_at: ${now}`,
          "last_ran_at: null",
          "last_run_status: null",
        ],
      })

      const schedules = await json<Json[]>(`/session/${sessionID}/schedule`, { query: sessionQuery() })
      expect(schedules).toHaveLength(1)
      expect(schedules[0]?.id).toBe(scheduleID)
      expect(schedules[0]?.kind).toBe("once")
      expect(schedules[0]?.expression).toBe(runAtIso)
      expect(schedules[0]?.runAt).toBe(runAt)
      expect(schedules[0]?.message).toBe("manual yaml scheduled message")
    } finally {
      await deleteSession(sessionID)
    }
  })

  test("hides archived sessions by default and restores them through includeArchived", async () => {
    const created = await createSession()
    const sessionID = String(created.id)

    try {
      await json<Json>(`/session/${sessionID}`, {
        method: "PATCH",
        query: sessionQuery(),
        body: JSON.stringify({ time: { archived: Date.now() } }),
      })

      const visible = await json<Json[]>("/session", { query: sessionQuery({ roots: true, limit: 100 }) })
      expect(visible.some((session) => session.id === sessionID)).toBe(false)

      const archived = await json<Json[]>("/session", {
        query: sessionQuery({ roots: true, includeArchived: true, limit: 100 }),
      })
      const restored = archived.find((session) => session.id === sessionID)
      expect(restored?.id).toBe(sessionID)
      expect(isRecord(restored?.time) && typeof restored.time.archived === "number").toBe(true)
    } finally {
      await deleteSession(sessionID)
    }
  })

  runPromptSuccessTest("keeps session.jsonl stable while changing session metadata and pending schedules", async () => {
    const created = await createSession()
    const sessionID = String(created.id)
    const text = "storage contract metadata separation prompt"

    try {
      await json<unknown>(`/session/${sessionID}/prompt_async`, {
        method: "POST",
        query: sessionQuery(),
        body: JSON.stringify({
          parts: [{ type: "text", text }],
        }),
      })

      const sessionJsonlPath = join(directory!, ".agents", "atree", "sessions", sessionID, "session.jsonl")
      const before = await readFile(sessionJsonlPath, "utf8")

      await json<Json>(`/session/${sessionID}`, {
        method: "PATCH",
        query: sessionQuery(),
        body: JSON.stringify({
          title: "Metadata-only session title",
          metadata: {
            atree: {
              emoji: "🧷",
            },
          },
        }),
      })
      const schedule = await json<Json>(`/session/${sessionID}/schedule`, {
        method: "POST",
        query: sessionQuery(),
        body: JSON.stringify({
          type: "at",
          at: Date.now() + 30 * 60_000,
          message: "pending schedule should stay out of raw history",
        }),
      })
      await json<boolean>(`/session/${sessionID}/schedule/${String(schedule.id)}`, {
        method: "DELETE",
        query: sessionQuery(),
      })
      await json<Json>(`/session/${sessionID}`, {
        method: "PATCH",
        query: sessionQuery(),
        body: JSON.stringify({ time: { archived: Date.now() } }),
      })
      await json<Json>(`/session/${sessionID}`, {
        method: "PATCH",
        query: sessionQuery(),
        body: JSON.stringify({ time: { archived: null } }),
      })

      const after = await readFile(sessionJsonlPath, "utf8")
      expect(after).toBe(before)

      const meta = await readFile(join(directory!, ".agents", "atree", "sessions", sessionID, "meta.yaml"), "utf8")
      expect(meta).toContain("title: Metadata-only session title")
      expect(meta).toContain("icon: 🧷")
      expect(meta).toContain("archived_at: null")
      expect(meta).not.toContain("schedule:")
    } finally {
      await deleteSession(sessionID)
    }
  })

  test("stores session emoji as directory icon metadata and restores it for the UI", async () => {
    const created = await createSession()
    const sessionID = String(created.id)
    const manualID = `ses_contract_icon_${Date.now().toString(36)}`
    const now = new Date().toISOString()

    try {
      await json<Json>(`/session/${sessionID}`, {
        method: "PATCH",
        query: sessionQuery(),
        body: JSON.stringify({
          metadata: {
            atree: {
              emoji: "🧭",
            },
          },
        }),
      })

      const meta = await readFile(join(directory!, ".agents", "atree", "sessions", sessionID, "meta.yaml"), "utf8")
      expect(meta.trim().startsWith("{")).toBe(false)
      expect(meta).toContain("icon: 🧭")

      await writeManualSession({
        id: manualID,
        title: "Manual icon source session",
        createdAt: now,
        updatedAt: now,
        icon: "🧪",
      })

      const restored = await json<Json>(`/session/${manualID}`, { query: sessionQuery() })
      expect(isRecord(restored.metadata)).toBe(true)
      expect(isRecord(restored.metadata.atree)).toBe(true)
      expect(restored.metadata.atree.emoji).toBe("🧪")
    } finally {
      await deleteSession(sessionID)
      await deleteSession(manualID)
    }
  })

  test("orders restored sessions by next schedule time before recent non-scheduled work", async () => {
    const suffix = Date.now().toString(36)
    const ids = {
      scheduledLater: `ses_contract_order_later_${suffix}`,
      scheduledSooner: `ses_contract_order_sooner_${suffix}`,
      normalFresh: `ses_contract_order_fresh_${suffix}`,
      normalOld: `ses_contract_order_old_${suffix}`,
    }
    const now = Date.now()
    const createdAt = new Date(now - 60 * 60_000).toISOString()

    try {
      await writeManualSession({
        id: ids.normalOld,
        title: "Normal old",
        createdAt,
        updatedAt: new Date(now - 30 * 60_000).toISOString(),
      })
      await writeManualSession({
        id: ids.normalFresh,
        title: "Normal fresh",
        createdAt,
        updatedAt: new Date(now - 1_000).toISOString(),
      })
      await writeManualSession({
        id: ids.scheduledLater,
        title: "Scheduled later",
        createdAt,
        updatedAt: new Date(now - 45 * 60_000).toISOString(),
        schedule: {
          id: `sch_later_${suffix}`,
          kind: "at",
          run_at: now + 30 * 60_000,
          message: "scheduled later",
          created_at: createdAt,
          last_ran_at: null,
          last_run_status: null,
        },
      })
      await writeManualSession({
        id: ids.scheduledSooner,
        title: "Scheduled sooner",
        createdAt,
        updatedAt: new Date(now - 50 * 60_000).toISOString(),
        schedule: {
          id: `sch_sooner_${suffix}`,
          kind: "at",
          run_at: now + 5 * 60_000,
          message: "scheduled sooner",
          created_at: createdAt,
          last_ran_at: null,
          last_run_status: null,
        },
      })

      const list = await json<Json[]>("/session", { query: sessionQuery({ roots: true, limit: 100 }) })
      const restoredOrder = list.map((session) => String(session.id)).filter((id) => Object.values(ids).includes(id))

      expect(restoredOrder).toEqual([ids.scheduledSooner, ids.scheduledLater, ids.normalFresh, ids.normalOld])
    } finally {
      for (const sessionID of Object.values(ids)) await deleteSession(sessionID)
    }
  })

  test("calculates cron nextRun from the first expression match after last_ran_at", async () => {
    const sessionID = `ses_contract_cron_next_${Date.now().toString(36)}`
    const now = Date.now()
    const createdAt = new Date(now).toISOString()
    const lastRanAt = Math.ceil((now + 60_000) / 60_000) * 60_000 + 5_000
    const expectedNextRun = Math.ceil(lastRanAt / 60_000) * 60_000

    try {
      await writeManualSession({
        id: sessionID,
        title: "Cron next run",
        createdAt,
        updatedAt: createdAt,
        schedule: {
          id: `sch_cron_next_${Date.now().toString(36)}`,
          kind: "cron",
          expression: "0 * * * * *",
          message: "cron next run contract",
          created_at: createdAt,
          last_ran_at: new Date(lastRanAt).toISOString(),
          last_run_status: "ran",
        },
      })

      const schedules = await json<Json[]>(`/session/${sessionID}/schedule`, { query: sessionQuery() })
      expect(schedules).toHaveLength(1)
      expect(schedules[0]?.kind).toBe("recurring")
      expect(schedules[0]?.lastRanAt).toBe(lastRanAt)
      expect(schedules[0]?.nextRun).toBe(expectedNextRun)
    } finally {
      await deleteSession(sessionID)
    }
  })

  runPromptSuccessTest("stores prompt_async user messages in Pi session.jsonl", async () => {
    const created = await createSession()
    const sessionID = String(created.id)
    const text = "storage contract prompt text"

    try {
      await json<unknown>(`/session/${sessionID}/prompt_async`, {
        method: "POST",
        query: sessionQuery(),
        body: JSON.stringify({
          parts: [{ type: "text", text }],
        }),
      })

      const sessionJsonl = await readFile(
        join(directory!, ".agents", "atree", "sessions", sessionID, "session.jsonl"),
        "utf8",
      )
      const entries = sessionJsonl
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Json)
      const userEntry = entries.find((entry) => {
        if (entry.type !== "message" || !isRecord(entry.message)) return false
        if (entry.message.role !== "user") return false
        if (!Array.isArray(entry.message.content)) return false
        return entry.message.content.some((part) => isRecord(part) && part.type === "text" && part.text === text)
      })
      expect(userEntry).toBeTruthy()
    } finally {
      await deleteSession(sessionID)
    }
  })

  runPromptSuccessTest("writes session.jsonl that the Pi parser can read", async () => {
    const created = await createSession()
    const sessionID = String(created.id)
    const text = "storage contract pi parser prompt"

    try {
      await json<unknown>(`/session/${sessionID}/prompt_async`, {
        method: "POST",
        query: sessionQuery(),
        body: JSON.stringify({
          parts: [{ type: "text", text }],
        }),
      })

      const sessionJsonlPath = join(directory!, ".agents", "atree", "sessions", sessionID, "session.jsonl")
      const sessionJsonl = await readFile(sessionJsonlPath, "utf8")
      const entries = parseSessionEntries(sessionJsonl) as Json[]
      const lines = sessionJsonl.trim().split("\n")
      expect(entries).toHaveLength(lines.length)

      const [header] = entries
      expect(header?.type).toBe("session")
      expect(header?.version).toBe(3)
      expect(header?.id).toBe(sessionID)
      expect(header?.cwd).toBe(directory)

      for (const entry of entries) {
        if (entry.type !== "message") continue
        expect(entry).not.toHaveProperty("info")
        expect(entry).not.toHaveProperty("parts")
        expect(isRecord(entry.message)).toBe(true)
      }

      const userEntry = entries.find((entry) => {
        if (entry.type !== "message" || !isRecord(entry.message)) return false
        if (entry.message.role !== "user" || !Array.isArray(entry.message.content)) return false
        return entry.message.content.some((part) => isRecord(part) && part.type === "text" && part.text === text)
      })
      expect(userEntry).toBeTruthy()
    } finally {
      await deleteSession(sessionID)
    }
  })

  test("restores Pi toolCall and toolResult history from handwritten session.jsonl", async () => {
    const sessionID = `ses_contract_tool_history_${Date.now().toString(36)}`
    const createdAt = new Date().toISOString()
    const toolCallID = `tool_contract_history_${Date.now().toString(36)}`
    const toolOutput = "handwritten Pi tool result payload"

    try {
      await writeManualSession({
        id: sessionID,
        title: "Tool history",
        createdAt,
        updatedAt: createdAt,
      })
      const sessionJsonlPath = join(directory!, ".agents", "atree", "sessions", sessionID, "session.jsonl")
      await writeFile(
        sessionJsonlPath,
        [
          JSON.stringify({
            type: "session",
            version: 3,
            id: sessionID,
            timestamp: createdAt,
            cwd: directory,
          }),
          JSON.stringify({
            type: "message",
            id: `${sessionID}_user`,
            parentId: null,
            timestamp: createdAt,
            message: {
              role: "user",
              content: [{ type: "text", text: "please read a file" }],
              timestamp: new Date(createdAt).getTime(),
            },
          }),
          JSON.stringify({
            type: "message",
            id: `${sessionID}_assistant`,
            parentId: `${sessionID}_user`,
            timestamp: createdAt,
            message: {
              role: "assistant",
              content: [
                {
                  type: "toolCall",
                  id: toolCallID,
                  name: "read",
                  arguments: { filePath: "README.md" },
                },
              ],
              timestamp: new Date(createdAt).getTime(),
            },
          }),
          JSON.stringify({
            type: "message",
            id: `${sessionID}_tool_result`,
            parentId: `${sessionID}_assistant`,
            timestamp: createdAt,
            message: {
              role: "toolResult",
              toolCallId: toolCallID,
              toolName: "read",
              content: [{ type: "text", text: toolOutput }],
              details: { output: toolOutput },
              timestamp: new Date(createdAt).getTime(),
            },
          }),
        ].join("\n") + "\n",
        "utf8",
      )

      const parsed = parseSessionEntries(await readFile(sessionJsonlPath, "utf8")) as Json[]
      expect(parsed).toHaveLength(4)

      const messages = await json<Json[]>(`/session/${sessionID}/message`, { query: sessionQuery() })
      const toolPart = messages
        .flatMap((message) => (Array.isArray(message.parts) ? message.parts : []))
        .find((part) => {
          if (!isRecord(part) || part.type !== "tool" || part.tool !== "read") return false
          return (
            isRecord(part.state) &&
            part.state.status === "completed" &&
            part.state.output === toolOutput &&
            isRecord(part.state.input) &&
            part.state.input.filePath === "README.md"
          )
        })
      expect(toolPart).toBeTruthy()
    } finally {
      await deleteSession(sessionID)
    }
  })

  runPromptSuccessTest("appends prompt_async entries without rewriting existing session.jsonl lines", async () => {
    const created = await createSession()
    const sessionID = String(created.id)
    const firstText = "storage contract append-only first prompt"
    const secondText = "storage contract append-only second prompt"

    try {
      await json<unknown>(`/session/${sessionID}/prompt_async`, {
        method: "POST",
        query: sessionQuery(),
        body: JSON.stringify({
          parts: [{ type: "text", text: firstText }],
        }),
      })
      const sessionJsonlPath = join(directory!, ".agents", "atree", "sessions", sessionID, "session.jsonl")
      const before = await readFile(sessionJsonlPath, "utf8")

      await json<unknown>(`/session/${sessionID}/prompt_async`, {
        method: "POST",
        query: sessionQuery(),
        body: JSON.stringify({
          parts: [{ type: "text", text: secondText }],
        }),
      })

      const after = await readFile(sessionJsonlPath, "utf8")
      const beforeLines = before.trim().split("\n")
      const afterLines = after.trim().split("\n")
      expect(afterLines.slice(0, beforeLines.length)).toEqual(beforeLines)
      expect(afterLines.length).toBeGreaterThan(beforeLines.length)

      const appendedEntries = afterLines.slice(beforeLines.length).map((line) => JSON.parse(line) as Json)
      const appendedUserEntry = appendedEntries.find((entry) => {
        if (entry.type !== "message" || !isRecord(entry.message)) return false
        if (entry.message.role !== "user" || !Array.isArray(entry.message.content)) return false
        return entry.message.content.some((part) => isRecord(part) && part.type === "text" && part.text === secondText)
      })
      expect(appendedUserEntry).toBeTruthy()
    } finally {
      await deleteSession(sessionID)
    }
  })

  runPromptSuccessTest(
    "stores data URL file parts as session assets with relative session.jsonl references",
    async () => {
      const created = await createSession()
      const sessionID = String(created.id)
      const text = "storage contract asset prompt"
      const assetText = "asset contract payload"
      const encodedAsset = Buffer.from(assetText).toString("base64")

      try {
        await json<unknown>(`/session/${sessionID}/prompt_async`, {
          method: "POST",
          query: sessionQuery(),
          body: JSON.stringify({
            parts: [
              { type: "text", text },
              {
                type: "file",
                mime: "text/plain",
                filename: "note.txt",
                url: `data:text/plain;base64,${encodedAsset}`,
              },
            ],
          }),
        })

        const assetRoot = join(directory!, ".agents", "atree", "sessions", sessionID, "assets")
        const assets = await readdir(assetRoot)
        expect(assets).toHaveLength(1)
        const assetPath = join(assetRoot, assets[0]!)
        expect(await readFile(assetPath, "utf8")).toBe(assetText)
        expect(await exists(join(directory!, ".agents", "atree", "sessions", sessionID, "attachments"))).toBe(false)

        const sessionJsonl = await readFile(
          join(directory!, ".agents", "atree", "sessions", sessionID, "session.jsonl"),
          "utf8",
        )
        const entries = sessionJsonl
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as Json)
        const userEntry = entries.find((entry) => {
          if (entry.type !== "message" || !isRecord(entry.message)) return false
          if (entry.message.role !== "user" || !Array.isArray(entry.message.content)) return false
          return entry.message.content.some(
            (part) =>
              isRecord(part) &&
              part.type === "file" &&
              part.path === `assets/${assets[0]}` &&
              part.mime === "text/plain" &&
              part.filename === "note.txt",
          )
        })
        expect(userEntry).toBeTruthy()
        expect(sessionJsonl).not.toContain("data:text/plain")
        expect(sessionJsonl).not.toContain(encodedAsset)

        const messages = await json<Json[]>(`/session/${sessionID}/message`, { query: sessionQuery() })
        const filePart = messages
          .flatMap((message) => (Array.isArray(message.parts) ? message.parts : []))
          .find((part) => {
            return (
              isRecord(part) &&
              part.type === "file" &&
              part.url === `assets/${assets[0]}` &&
              part.filename === "note.txt"
            )
          })
        expect(filePart).toBeTruthy()
      } finally {
        await deleteSession(sessionID)
      }
    },
  )

  runPromptSuccessTest("deletes the whole self-contained session directory including assets", async () => {
    const created = await createSession()
    const sessionID = String(created.id)
    const text = "storage contract delete self-contained session prompt"
    const assetText = "delete self-contained session asset payload"
    let deleted = false

    try {
      await json<unknown>(`/session/${sessionID}/prompt_async`, {
        method: "POST",
        query: sessionQuery(),
        body: JSON.stringify({
          parts: [
            { type: "text", text },
            {
              type: "file",
              mime: "text/plain",
              filename: "delete-note.txt",
              url: `data:text/plain;base64,${Buffer.from(assetText).toString("base64")}`,
            },
          ],
        }),
      })

      const sessionRoot = join(directory!, ".agents", "atree", "sessions", sessionID)
      expect(await exists(join(sessionRoot, "meta.yaml"))).toBe(true)
      expect(await exists(join(sessionRoot, "session.jsonl"))).toBe(true)
      expect(await exists(join(sessionRoot, "assets"))).toBe(true)
      expect(await exists(join(sessionRoot, "attachments"))).toBe(false)

      await json<boolean>(`/session/${sessionID}`, {
        method: "DELETE",
        query: sessionQuery(),
      })
      deleted = true

      expect(await exists(sessionRoot)).toBe(false)
      const list = await json<Json[]>("/session", {
        query: sessionQuery({ roots: true, includeArchived: true, limit: 100 }),
      })
      expect(list.some((session) => session.id === sessionID)).toBe(false)
    } finally {
      if (!deleted) await deleteSession(sessionID)
    }
  })

  runPromptSuccessTest(
    "stores local file URL parts as session assets with relative session.jsonl references",
    async () => {
      const created = await createSession()
      const sessionID = String(created.id)
      const text = "storage contract local file asset prompt"
      const assetText = "local file asset payload"
      const localFile = join(directory!, "source-local-asset.txt")

      try {
        await writeFile(localFile, assetText, "utf8")
        const localFileUrl = `${pathToFileURL(localFile).toString()}?start=1&end=1`

        await json<unknown>(`/session/${sessionID}/prompt_async`, {
          method: "POST",
          query: sessionQuery(),
          body: JSON.stringify({
            parts: [
              { type: "text", text },
              {
                type: "file",
                mime: "text/plain",
                filename: "source-local-asset.txt",
                url: localFileUrl,
              },
            ],
          }),
        })

        const assetRoot = join(directory!, ".agents", "atree", "sessions", sessionID, "assets")
        const assets = await readdir(assetRoot)
        expect(assets).toHaveLength(1)
        expect(await readFile(join(assetRoot, assets[0]!), "utf8")).toBe(assetText)

        const sessionJsonl = await readFile(
          join(directory!, ".agents", "atree", "sessions", sessionID, "session.jsonl"),
          "utf8",
        )
        expect(sessionJsonl).toContain(`assets/${assets[0]}`)
        expect(sessionJsonl).not.toContain("file://")
        expect(sessionJsonl).not.toContain(localFile)

        const messages = await json<Json[]>(`/session/${sessionID}/message`, { query: sessionQuery() })
        const filePart = messages
          .flatMap((message) => (Array.isArray(message.parts) ? message.parts : []))
          .find((part) => {
            return (
              isRecord(part) &&
              part.type === "file" &&
              part.url === `assets/${assets[0]}` &&
              part.filename === "source-local-asset.txt"
            )
          })
        expect(filePart).toBeTruthy()
      } finally {
        await deleteSession(sessionID)
        await rm(localFile, { force: true })
      }
    },
  )

  runPromptSuccessTest(
    "stores absolute local path file parts as session assets with relative session.jsonl references",
    async () => {
      const created = await createSession()
      const sessionID = String(created.id)
      const text = "storage contract absolute path asset prompt"
      const assetText = "absolute path asset payload"
      const localFile = join(directory!, "source-absolute-asset.txt")

      try {
        await writeFile(localFile, assetText, "utf8")

        await json<unknown>(`/session/${sessionID}/prompt_async`, {
          method: "POST",
          query: sessionQuery(),
          body: JSON.stringify({
            parts: [
              { type: "text", text },
              {
                type: "file",
                mime: "text/plain",
                filename: "source-absolute-asset.txt",
                url: localFile,
              },
            ],
          }),
        })

        const assetRoot = join(directory!, ".agents", "atree", "sessions", sessionID, "assets")
        const assets = await readdir(assetRoot)
        expect(assets).toHaveLength(1)
        expect(await readFile(join(assetRoot, assets[0]!), "utf8")).toBe(assetText)

        const sessionJsonl = await readFile(
          join(directory!, ".agents", "atree", "sessions", sessionID, "session.jsonl"),
          "utf8",
        )
        expect(sessionJsonl).toContain(`assets/${assets[0]}`)
        expect(sessionJsonl).not.toContain(localFile)

        const messages = await json<Json[]>(`/session/${sessionID}/message`, { query: sessionQuery() })
        const filePart = messages
          .flatMap((message) => (Array.isArray(message.parts) ? message.parts : []))
          .find((part) => {
            return (
              isRecord(part) &&
              part.type === "file" &&
              part.url === `assets/${assets[0]}` &&
              part.filename === "source-absolute-asset.txt"
            )
          })
        expect(filePart).toBeTruthy()
      } finally {
        await deleteSession(sessionID)
        await rm(localFile, { force: true })
      }
    },
  )

  runPromptSuccessTest("restores sessions, schedules, and assets after copying the whole directory", async () => {
    const created = await createSession()
    const sessionID = String(created.id)
    const text = "storage contract copied directory prompt"
    const assetText = "copied directory asset payload"
    const runAt = Date.now() + 15 * 60_000
    const copiedParent = await mkdtemp(join(tmpdir(), "atree-contract-copy-"))
    const copiedDirectory = join(copiedParent, "workspace-copy")

    try {
      await json<Json>(`/session/${sessionID}`, {
        method: "PATCH",
        query: sessionQuery(),
        body: JSON.stringify({
          title: "Copyable directory session",
          metadata: {
            atree: {
              emoji: "📦",
            },
          },
        }),
      })

      const schedule = await json<Json>(`/session/${sessionID}/schedule`, {
        method: "POST",
        query: sessionQuery(),
        body: JSON.stringify({
          type: "at",
          at: runAt,
          message: "copied directory scheduled message",
        }),
      })

      await json<unknown>(`/session/${sessionID}/prompt_async`, {
        method: "POST",
        query: sessionQuery(),
        body: JSON.stringify({
          parts: [
            { type: "text", text },
            {
              type: "file",
              mime: "text/plain",
              filename: "copied-note.txt",
              url: `data:text/plain;base64,${Buffer.from(assetText).toString("base64")}`,
            },
          ],
        }),
      })

      await cp(directory!, copiedDirectory, { recursive: true })
      const copiedDirectoryReal = await realpath(copiedDirectory)

      const copiedQuery = { directory: copiedDirectoryReal, roots: true, includeArchived: true, limit: 100 }
      const list = await json<Json[]>("/session", { query: copiedQuery })
      const restored = list.find((session) => session.id === sessionID)
      expect(restored?.title).toBe("Copyable directory session")
      expect(isRecord(restored?.metadata)).toBe(true)
      expect(isRecord(restored?.metadata.atree)).toBe(true)
      expect(restored.metadata.atree.emoji).toBe("📦")

      const schedules = await json<Json[]>(`/session/${sessionID}/schedule`, {
        query: { directory: copiedDirectoryReal },
      })
      expect(schedules).toHaveLength(1)
      expect(schedules[0]?.id).toBe(schedule.id)
      expect(schedules[0]?.message).toBe("copied directory scheduled message")
      expect(schedules[0]?.kind).toBe("once")

      const assetRoot = join(copiedDirectory, ".agents", "atree", "sessions", sessionID, "assets")
      const assets = await readdir(assetRoot)
      expect(assets).toHaveLength(1)
      expect(await readFile(join(assetRoot, assets[0]!), "utf8")).toBe(assetText)

      const copiedJsonl = await readFile(
        join(copiedDirectory, ".agents", "atree", "sessions", sessionID, "session.jsonl"),
        "utf8",
      )
      const [copiedHeaderLine] = copiedJsonl.trim().split("\n")
      const copiedHeader = JSON.parse(copiedHeaderLine!) as Json
      expect(copiedHeader.cwd).toBe(copiedDirectoryReal)
      expect(copiedJsonl).toContain(text)
      expect(copiedJsonl).toContain(`assets/${assets[0]}`)
      expect(copiedJsonl).not.toContain("data:text/plain")

      const messages = await json<Json[]>(`/session/${sessionID}/message`, {
        query: { directory: copiedDirectoryReal },
      })
      const userText = messages.find((message) => {
        if (!isRecord(message.info) || message.info.role !== "user") return false
        if (!Array.isArray(message.parts)) return false
        return message.parts.some((part) => isRecord(part) && part.type === "text" && part.text === text)
      })
      const copiedFilePart = messages
        .flatMap((message) => (Array.isArray(message.parts) ? message.parts : []))
        .find((part) => {
          return (
            isRecord(part) &&
            part.type === "file" &&
            part.url === `assets/${assets[0]}` &&
            part.filename === "copied-note.txt"
          )
        })
      expect(userText).toBeTruthy()
      expect(copiedFilePart).toBeTruthy()
    } finally {
      await deleteSession(sessionID)
      await rm(copiedParent, { recursive: true, force: true })
    }
  })

  runPromptSuccessTest("restores a self-contained session directory moved into another workspace", async () => {
    const created = await createSession()
    const sessionID = String(created.id)
    const text = "storage contract moved session prompt"
    const assetText = "moved session asset payload"
    const targetParent = await mkdtemp(join(tmpdir(), "atree-contract-session-move-"))
    const targetDirectory = join(targetParent, "target-workspace")

    try {
      await json<Json>(`/session/${sessionID}`, {
        method: "PATCH",
        query: sessionQuery(),
        body: JSON.stringify({
          title: "Movable session",
          metadata: {
            atree: {
              emoji: "🚚",
            },
          },
        }),
      })

      const schedule = await json<Json>(`/session/${sessionID}/schedule`, {
        method: "POST",
        query: sessionQuery(),
        body: JSON.stringify({
          type: "at",
          at: Date.now() + 20 * 60_000,
          message: "moved session scheduled message",
        }),
      })

      await json<unknown>(`/session/${sessionID}/prompt_async`, {
        method: "POST",
        query: sessionQuery(),
        body: JSON.stringify({
          parts: [
            { type: "text", text },
            {
              type: "file",
              mime: "text/plain",
              filename: "moved-note.txt",
              url: `data:text/plain;base64,${Buffer.from(assetText).toString("base64")}`,
            },
          ],
        }),
      })

      const sourceSessionRoot = join(directory!, ".agents", "atree", "sessions", sessionID)
      const targetSessionRoot = join(targetDirectory, ".agents", "atree", "sessions", sessionID)
      await mkdir(join(targetDirectory, ".agents", "atree", "sessions"), { recursive: true })
      await rename(sourceSessionRoot, targetSessionRoot)
      const targetDirectoryReal = await realpath(targetDirectory)

      const sourceList = await json<Json[]>("/session", {
        query: sessionQuery({ roots: true, includeArchived: true, limit: 100 }),
      })
      expect(sourceList.some((session) => session.id === sessionID)).toBe(false)

      const targetList = await json<Json[]>("/session", {
        query: { directory: targetDirectoryReal, roots: true, includeArchived: true, limit: 100 },
      })
      const restored = targetList.find((session) => session.id === sessionID)
      expect(restored?.title).toBe("Movable session")
      expect(isRecord(restored?.metadata)).toBe(true)
      expect(isRecord(restored?.metadata.atree)).toBe(true)
      expect(restored.metadata.atree.emoji).toBe("🚚")

      const movedJsonl = await readFile(join(targetSessionRoot, "session.jsonl"), "utf8")
      const [movedHeaderLine] = movedJsonl.trim().split("\n")
      const movedHeader = JSON.parse(movedHeaderLine!) as Json
      expect(movedHeader.cwd).toBe(targetDirectoryReal)

      const schedules = await json<Json[]>(`/session/${sessionID}/schedule`, {
        query: { directory: targetDirectoryReal },
      })
      expect(schedules).toHaveLength(1)
      expect(schedules[0]?.id).toBe(schedule.id)
      expect(schedules[0]?.message).toBe("moved session scheduled message")

      const assetRoot = join(targetSessionRoot, "assets")
      const assets = await readdir(assetRoot)
      expect(assets).toHaveLength(1)
      expect(await readFile(join(assetRoot, assets[0]!), "utf8")).toBe(assetText)

      const messages = await json<Json[]>(`/session/${sessionID}/message`, {
        query: { directory: targetDirectoryReal },
      })
      const userText = messages.find((message) => {
        if (!isRecord(message.info) || message.info.role !== "user") return false
        if (!Array.isArray(message.parts)) return false
        return message.parts.some((part) => isRecord(part) && part.type === "text" && part.text === text)
      })
      const movedFilePart = messages
        .flatMap((message) => (Array.isArray(message.parts) ? message.parts : []))
        .find((part) => {
          return (
            isRecord(part) &&
            part.type === "file" &&
            part.url === `assets/${assets[0]}` &&
            part.filename === "moved-note.txt"
          )
        })
      expect(userText).toBeTruthy()
      expect(movedFilePart).toBeTruthy()
    } finally {
      await deleteSession(sessionID)
      await rm(targetParent, { recursive: true, force: true })
    }
  })

  test("archives a scheduled session by clearing the schedule in directory metadata", async () => {
    const created = await createSession()
    const sessionID = String(created.id)

    try {
      await json<Json>(`/session/${sessionID}/schedule`, {
        method: "POST",
        query: sessionQuery(),
        body: JSON.stringify({
          type: "at",
          at: Date.now() + 10 * 60_000,
          message: "storage contract scheduled message",
        }),
      })

      const before = await json<Json[]>(`/session/${sessionID}/schedule`, { query: sessionQuery() })
      expect(before).toHaveLength(1)

      await json<Json>(`/session/${sessionID}`, {
        method: "PATCH",
        query: sessionQuery(),
        body: JSON.stringify({ time: { archived: Date.now() } }),
      })

      const after = await json<Json[]>(`/session/${sessionID}/schedule`, { query: sessionQuery() })
      expect(after).toHaveLength(0)

      const meta = await readFile(join(directory!, ".agents", "atree", "sessions", sessionID, "meta.yaml"), "utf8")
      expect(meta.trim().startsWith("{")).toBe(false)
      expect(meta).toMatch(/archived_at: .+/)
      expect(meta).not.toContain("schedule:")
    } finally {
      await deleteSession(sessionID)
    }
  })

  runPromptSuccessTest("runs due at schedules into session.jsonl and clears the pending schedule", async () => {
    const created = await createSession()
    const sessionID = String(created.id)
    const text = "storage contract due scheduled message"
    let scheduleID = ""

    try {
      await withEventStream(async (stream) => {
        await stream.next((event) => event.payload?.type === "server.connected")

        const schedule = await json<Json>(`/session/${sessionID}/schedule`, {
          method: "POST",
          query: sessionQuery(),
          body: JSON.stringify({
            type: "at",
            at: Date.now() + 250,
            message: text,
          }),
        })
        scheduleID = String(schedule.id)

        const ran = await stream.next((event) => {
          if (event.directory !== directory || event.payload?.type !== "schedule.ran") return false
          const properties = event.payload.properties
          return (
            isRecord(properties) &&
            properties.sessionID === sessionID &&
            properties.scheduleID === scheduleID &&
            properties.source === "atree-scheduler"
          )
        })
        expect(ran.payload?.type).toBe("schedule.ran")

        await stream.next((event) => {
          if (event.directory !== directory || event.payload?.type !== "schedule.deleted") return false
          const properties = event.payload.properties
          return isRecord(properties) && properties.sessionID === sessionID && properties.scheduleID === scheduleID
        })
      })

      const schedules = await json<Json[]>(`/session/${sessionID}/schedule`, { query: sessionQuery() })
      expect(schedules).toHaveLength(0)

      const messages = await json<Json[]>(`/session/${sessionID}/message`, { query: sessionQuery() })
      const scheduledMessage = messages.find((message) => {
        if (!isRecord(message.info) || message.info.role !== "user" || message.info.agent !== "automation") return false
        if (!Array.isArray(message.parts)) return false
        return message.parts.some((part) => isRecord(part) && part.type === "text" && part.text === text)
      })
      expect(scheduledMessage).toBeTruthy()

      const sessionJsonl = await readFile(
        join(directory!, ".agents", "atree", "sessions", sessionID, "session.jsonl"),
        "utf8",
      )
      const entries = sessionJsonl
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Json)
      const userEntry = entries.find((entry) => {
        if (entry.type !== "message" || !isRecord(entry.message)) return false
        if (entry.message.role !== "user" || !isRecord(entry.message.source)) return false
        if (entry.message.source.type !== "schedule" || entry.message.source.scheduleID !== scheduleID) return false
        if (!Array.isArray(entry.message.content)) return false
        return entry.message.content.some((part) => isRecord(part) && part.type === "text" && part.text === text)
      })
      expect(userEntry).toBeTruthy()
    } finally {
      await deleteSession(sessionID)
    }
  })

  runPromptSuccessTest("serializes manual prompt and due schedule writes for the same session", async () => {
    const created = await createSession()
    const sessionID = String(created.id)
    const scheduledText = "storage contract concurrent scheduled message"
    const manualText = "storage contract concurrent manual message"
    const assetText = "storage contract concurrent asset payload"
    const fifoRoot = join(directory!, ".agents", "atree-contract")
    const fifoPath = join(fifoRoot, `prompt-${sessionID}.txt`)
    let scheduleID = ""

    try {
      await mkdir(fifoRoot, { recursive: true })
      const mkfifo = Bun.spawnSync(["mkfifo", fifoPath])
      expect(mkfifo.exitCode).toBe(0)

      await withEventStream(async (stream) => {
        await stream.next((event) => event.payload?.type === "server.connected")

        const schedule = await json<Json>(`/session/${sessionID}/schedule`, {
          method: "POST",
          query: sessionQuery(),
          body: JSON.stringify({
            type: "at",
            at: Date.now() + 100,
            message: scheduledText,
          }),
        })
        scheduleID = String(schedule.id)

        const manualRequest = json<unknown>(`/session/${sessionID}/prompt_async`, {
          method: "POST",
          query: sessionQuery(),
          body: JSON.stringify({
            parts: [
              { type: "text", text: manualText },
              {
                type: "file",
                mime: "text/plain",
                filename: "concurrent.txt",
                url: pathToFileURL(fifoPath).toString(),
              },
            ],
          }),
        })

        await sleep(1_200)
        await writeFile(fifoPath, assetText, "utf8")
        await manualRequest

        const ran = await stream.next((event) => {
          if (event.directory !== directory || event.payload?.type !== "schedule.ran") return false
          const properties = event.payload.properties
          return (
            isRecord(properties) &&
            properties.sessionID === sessionID &&
            properties.scheduleID === scheduleID &&
            properties.status === "ran"
          )
        })
        expect(ran.payload?.type).toBe("schedule.ran")

        await stream.next((event) => {
          if (event.directory !== directory || event.payload?.type !== "schedule.deleted") return false
          const properties = event.payload.properties
          return isRecord(properties) && properties.sessionID === sessionID && properties.scheduleID === scheduleID
        })
      })

      const schedules = await json<Json[]>(`/session/${sessionID}/schedule`, { query: sessionQuery() })
      expect(schedules).toHaveLength(0)

      const sessionJsonl = await readFile(
        join(directory!, ".agents", "atree", "sessions", sessionID, "session.jsonl"),
        "utf8",
      )
      const entries = sessionJsonl
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Json)

      const manualEntry = entries.find((entry) => {
        if (entry.type !== "message" || !isRecord(entry.message)) return false
        if (entry.message.role !== "user" || !Array.isArray(entry.message.content)) return false
        return entry.message.content.some((part) => isRecord(part) && part.type === "text" && part.text === manualText)
      })
      expect(manualEntry).toBeTruthy()

      const scheduledEntry = entries.find((entry) => {
        if (entry.type !== "message" || !isRecord(entry.message)) return false
        if (entry.message.role !== "user" || !isRecord(entry.message.source)) return false
        if (entry.message.source.type !== "schedule" || entry.message.source.scheduleID !== scheduleID) return false
        if (!Array.isArray(entry.message.content)) return false
        return entry.message.content.some(
          (part) => isRecord(part) && part.type === "text" && part.text === scheduledText,
        )
      })
      expect(scheduledEntry).toBeTruthy()

      const meta = await readFile(join(directory!, ".agents", "atree", "sessions", sessionID, "meta.yaml"), "utf8")
      expect(meta).not.toContain("schedule:")
    } finally {
      await deleteSession(sessionID)
      await rm(fifoRoot, { recursive: true, force: true })
    }
  })

  runPromptSuccessTest("runs due cron schedules into session.jsonl and keeps the recurring schedule", async () => {
    const created = await createSession()
    const sessionID = String(created.id)
    const text = "storage contract due cron scheduled message"
    let scheduleID = ""

    try {
      await withEventStream(async (stream) => {
        await stream.next((event) => event.payload?.type === "server.connected")

        const schedule = await json<Json>(`/session/${sessionID}/schedule`, {
          method: "POST",
          query: sessionQuery(),
          body: JSON.stringify({
            type: "cron",
            cron: "*/1 * * * * *",
            message: text,
          }),
        })
        scheduleID = String(schedule.id)
        expect(schedule.kind).toBe("recurring")
        expect(schedule.nextRun).toEqual(expect.any(Number))

        const ran = await stream.next((event) => {
          if (event.directory !== directory || event.payload?.type !== "schedule.ran") return false
          const properties = event.payload.properties
          return (
            isRecord(properties) &&
            properties.sessionID === sessionID &&
            properties.scheduleID === scheduleID &&
            properties.status === "ran"
          )
        })
        expect(ran.payload?.type).toBe("schedule.ran")
      })

      const schedules = await json<Json[]>(`/session/${sessionID}/schedule`, { query: sessionQuery() })
      expect(schedules).toHaveLength(1)
      expect(schedules[0]?.id).toBe(scheduleID)
      expect(schedules[0]?.kind).toBe("recurring")
      expect(schedules[0]?.lastRunStatus).toBe("ran")
      expect(schedules[0]?.lastRanAt).toEqual(expect.any(Number))
      expect(schedules[0]?.nextRun).toEqual(expect.any(Number))
      expect(Number(schedules[0]?.nextRun)).toBeGreaterThan(Number(schedules[0]?.lastRanAt))

      const messages = await json<Json[]>(`/session/${sessionID}/message`, { query: sessionQuery() })
      const scheduledMessage = messages.find((message) => {
        if (!isRecord(message.info) || message.info.role !== "user" || message.info.agent !== "automation") return false
        if (!Array.isArray(message.parts)) return false
        return message.parts.some((part) => isRecord(part) && part.type === "text" && part.text === text)
      })
      expect(scheduledMessage).toBeTruthy()

      const sessionJsonl = await readFile(
        join(directory!, ".agents", "atree", "sessions", sessionID, "session.jsonl"),
        "utf8",
      )
      const entries = sessionJsonl
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Json)
      const userEntry = entries.find((entry) => {
        if (entry.type !== "message" || !isRecord(entry.message)) return false
        if (entry.message.role !== "user" || !isRecord(entry.message.source)) return false
        if (entry.message.source.type !== "schedule" || entry.message.source.scheduleKind !== "cron") return false
        if (entry.message.source.scheduleID !== scheduleID) return false
        if (!Array.isArray(entry.message.content)) return false
        return entry.message.content.some((part) => isRecord(part) && part.type === "text" && part.text === text)
      })
      expect(userEntry).toBeTruthy()
    } finally {
      await deleteSession(sessionID)
    }
  })
})

if (process.env.ATREE_PI_EXECUTION_CONTRACT === "1")
  describe("atree Pi execution contract", () => {
    beforeAll(async () => {
      await ensureTestDirectory()
      const health = await json<Json>("/global/health")
      expect(health.healthy).toBe(true)
    })

    afterAll(async () => {
      if (cleanupDirectory && directory) await rm(directory, { recursive: true, force: true })
    })

    test("runs prompt_async through Pi AgentSession and persists assistant output", async () => {
      const created = await createSession()
      const sessionID = String(created.id)
      const text = "contract pi execution prompt"

      try {
        await json<unknown>(`/session/${sessionID}/prompt_async`, {
          method: "POST",
          query: sessionQuery(),
          body: JSON.stringify({
            parts: [{ type: "text", text }],
          }),
        })

        const messages = await json<Json[]>(`/session/${sessionID}/message`, { query: sessionQuery() })
        const assistant = messages.find((message) => {
          if (!isRecord(message.info) || message.info.role !== "assistant") return false
          if (!Array.isArray(message.parts)) return false
          return message.parts.some(
            (part) => isRecord(part) && part.type === "text" && part.text === `atree faux response: ${text}`,
          )
        })
        expect(assistant).toBeTruthy()
        const user = messages.find((message) => isRecord(message.info) && message.info.role === "user")
        expect(user).toBeTruthy()
        expect((assistant?.info as Json | undefined)?.parentID).toBe((user?.info as Json | undefined)?.id)

        const sessionJsonl = await readFile(
          join(directory!, ".agents", "atree", "sessions", sessionID, "session.jsonl"),
          "utf8",
        )
        const entries = sessionJsonl
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as Json)
        const assistantEntry = entries.find((entry) => {
          if (entry.type !== "message" || !isRecord(entry.message)) return false
          if (entry.message.role !== "assistant") return false
          if (!Array.isArray(entry.message.content)) return false
          return entry.message.content.some(
            (part) => isRecord(part) && part.type === "text" && part.text === `atree faux response: ${text}`,
          )
        })
        expect(assistantEntry).toBeTruthy()
      } finally {
        await deleteSession(sessionID)
      }
    })

    test("binds Pi extensions and fires startup, resource discovery, and prompt lifecycle events", async () => {
      const created = await createSession()
      const sessionID = String(created.id)
      const text = "contract pi extension lifecycle prompt"
      const eventPath = await installPiLifecycleExtension()

      try {
        await json<unknown>(`/session/${sessionID}/prompt_async`, {
          method: "POST",
          query: sessionQuery(),
          body: JSON.stringify({
            parts: [{ type: "text", text }],
          }),
        })

        await readLifecycleExtensionEvents(eventPath, text)
      } finally {
        await deleteSession(sessionID)
        await cleanupPiLifecycleExtension()
      }
    })

    test("runs due at schedules through Pi AgentSession and persists assistant output", async () => {
      const created = await createSession()
      const sessionID = String(created.id)
      const text = "contract pi scheduled execution prompt"
      let scheduleID = ""

      try {
        await withEventStream(async (stream) => {
          await stream.next((event) => event.payload?.type === "server.connected")

          const schedule = await json<Json>(`/session/${sessionID}/schedule`, {
            method: "POST",
            query: sessionQuery(),
            body: JSON.stringify({
              type: "at",
              at: Date.now() + 250,
              message: text,
            }),
          })
          scheduleID = String(schedule.id)

          await stream.next((event) => {
            if (event.directory !== directory || event.payload?.type !== "session.status") return false
            const properties = event.payload.properties
            return (
              isRecord(properties) &&
              properties.sessionID === sessionID &&
              isRecord(properties.status) &&
              properties.status.type === "busy"
            )
          })

          const delta = await stream.next((event) => {
            if (event.directory !== directory || event.payload?.type !== "message.part.delta") return false
            const properties = event.payload.properties
            return (
              isRecord(properties) &&
              properties.sessionID === sessionID &&
              typeof properties.delta === "string" &&
              properties.delta.includes(`atree faux response: ${text}`)
            )
          })
          expect(delta.payload?.type).toBe("message.part.delta")

          const ran = await stream.next((event) => {
            if (event.directory !== directory || event.payload?.type !== "schedule.ran") return false
            const properties = event.payload.properties
            return (
              isRecord(properties) &&
              properties.sessionID === sessionID &&
              properties.scheduleID === scheduleID &&
              properties.status === "ran"
            )
          })
          expect(ran.payload?.type).toBe("schedule.ran")
        })

        const schedules = await json<Json[]>(`/session/${sessionID}/schedule`, { query: sessionQuery() })
        expect(schedules).toHaveLength(0)

        const messages = await json<Json[]>(`/session/${sessionID}/message`, { query: sessionQuery() })
        const scheduledUser = messages.find((message) => {
          if (!isRecord(message.info) || message.info.role !== "user" || message.info.agent !== "automation")
            return false
          if (!Array.isArray(message.parts)) return false
          return message.parts.some((part) => isRecord(part) && part.type === "text" && part.text === text)
        })
        expect(scheduledUser).toBeTruthy()

        const assistant = messages.find((message) => {
          if (!isRecord(message.info) || message.info.role !== "assistant") return false
          if (!Array.isArray(message.parts)) return false
          return message.parts.some(
            (part) => isRecord(part) && part.type === "text" && part.text === `atree faux response: ${text}`,
          )
        })
        expect(assistant).toBeTruthy()

        const sessionJsonl = await readFile(
          join(directory!, ".agents", "atree", "sessions", sessionID, "session.jsonl"),
          "utf8",
        )
        const entries = sessionJsonl
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as Json)
        const userEntry = entries.find((entry) => {
          if (entry.type !== "message" || !isRecord(entry.message)) return false
          if (entry.message.role !== "user" || !isRecord(entry.message.source)) return false
          return entry.message.source.type === "schedule" && entry.message.source.scheduleID === scheduleID
        })
        expect(userEntry).toBeTruthy()
        const assistantEntry = entries.find((entry) => {
          if (entry.type !== "message" || !isRecord(entry.message)) return false
          if (entry.message.role !== "assistant" || !Array.isArray(entry.message.content)) return false
          return entry.message.content.some(
            (part) => isRecord(part) && part.type === "text" && part.text === `atree faux response: ${text}`,
          )
        })
        expect(assistantEntry).toBeTruthy()
      } finally {
        await deleteSession(sessionID)
      }
    })

    test("streams Pi AgentSession message events while prompt_async is running", async () => {
      const created = await createSession()
      const sessionID = String(created.id)
      const text = "contract pi streaming prompt"

      try {
        await withEventStream(async (stream) => {
          await stream.next((event) => event.payload?.type === "server.connected")

          const request = json<unknown>(`/session/${sessionID}/prompt_async`, {
            method: "POST",
            query: sessionQuery(),
            body: JSON.stringify({
              parts: [{ type: "text", text }],
            }),
          })

          const busy = await stream.next((event) => {
            if (event.directory !== directory || event.payload?.type !== "session.status") return false
            const properties = event.payload.properties
            return (
              isRecord(properties) &&
              properties.sessionID === sessionID &&
              isRecord(properties.status) &&
              properties.status.type === "busy"
            )
          })
          expect(busy.payload?.type).toBe("session.status")

          const user = await stream.next((event) => {
            if (event.directory !== directory || event.payload?.type !== "message.updated") return false
            const properties = event.payload.properties
            return (
              isRecord(properties) &&
              isRecord(properties.info) &&
              properties.info.sessionID === sessionID &&
              properties.info.role === "user"
            )
          })
          expect(user.payload?.type).toBe("message.updated")

          const delta = await stream.next((event) => {
            if (event.directory !== directory || event.payload?.type !== "message.part.delta") return false
            const properties = event.payload.properties
            return (
              isRecord(properties) &&
              properties.sessionID === sessionID &&
              typeof properties.delta === "string" &&
              properties.delta.includes(`atree faux response: ${text}`)
            )
          })
          expect(delta.payload?.type).toBe("message.part.delta")

          await request

          const idle = await stream.next((event) => {
            if (event.directory !== directory || event.payload?.type !== "session.status") return false
            const properties = event.payload.properties
            return (
              isRecord(properties) &&
              properties.sessionID === sessionID &&
              isRecord(properties.status) &&
              properties.status.type === "idle"
            )
          })
          expect(idle.payload?.type).toBe("session.status")
        })
      } finally {
        await deleteSession(sessionID)
      }
    })

    test("streams Pi tool execution events as tool parts and persists them in session history", async () => {
      const created = await createSession()
      const sessionID = String(created.id)
      const text = "contract pi tool prompt"

      try {
        await withEventStream(async (stream) => {
          await stream.next((event) => event.payload?.type === "server.connected")

          const request = json<unknown>(`/session/${sessionID}/prompt_async`, {
            method: "POST",
            query: sessionQuery(),
            body: JSON.stringify({
              parts: [{ type: "text", text }],
            }),
          })

          const running = await stream.next((event) => {
            if (event.directory !== directory || event.payload?.type !== "message.part.updated") return false
            const properties = event.payload.properties
            if (!isRecord(properties) || !isRecord(properties.part)) return false
            const part = properties.part
            if (part.sessionID !== sessionID || part.type !== "tool" || part.tool !== "atree_echo") return false
            return isRecord(part.state) && part.state.status === "running"
          })
          expect(running.payload?.type).toBe("message.part.updated")

          const completed = await stream.next((event) => {
            if (event.directory !== directory || event.payload?.type !== "message.part.updated") return false
            const properties = event.payload.properties
            if (!isRecord(properties) || !isRecord(properties.part)) return false
            const part = properties.part
            if (part.sessionID !== sessionID || part.type !== "tool" || part.tool !== "atree_echo") return false
            return isRecord(part.state) && part.state.status === "completed" && part.state.output === "tool payload"
          })
          expect(completed.payload?.type).toBe("message.part.updated")

          await request
        })

        const messages = await json<Json[]>(`/session/${sessionID}/message`, { query: sessionQuery() })
        const toolPart = messages
          .flatMap((message) => (Array.isArray(message.parts) ? message.parts : []))
          .find((part) => {
            if (!isRecord(part) || part.type !== "tool" || part.tool !== "atree_echo") return false
            return isRecord(part.state) && part.state.status === "completed" && part.state.output === "tool payload"
          })
        expect(toolPart).toBeTruthy()

        const sessionJsonl = await readFile(
          join(directory!, ".agents", "atree", "sessions", sessionID, "session.jsonl"),
          "utf8",
        )
        const entries = sessionJsonl
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as Json)
        const toolResult = entries.find((entry) => {
          if (entry.type !== "message" || !isRecord(entry.message)) return false
          return (
            entry.message.role === "toolResult" &&
            entry.message.toolName === "atree_echo" &&
            entry.message.toolCallId === "tool_contract_echo"
          )
        })
        expect(toolResult).toBeTruthy()
      } finally {
        await deleteSession(sessionID)
      }
    })

    test("executes Pi built-in read tool through faux model and persists the tool result", async () => {
      const created = await createSession()
      const sessionID = String(created.id)
      const text = "contract pi read tool prompt"
      const fileText = "atree builtin read contract content"

      try {
        await writeFile(join(directory!, "contract-read.txt"), `${fileText}\n`, "utf8")

        await withEventStream(async (stream) => {
          await stream.next((event) => event.payload?.type === "server.connected")

          const request = json<unknown>(`/session/${sessionID}/prompt_async`, {
            method: "POST",
            query: sessionQuery(),
            body: JSON.stringify({
              parts: [{ type: "text", text }],
            }),
          })

          const running = await stream.next((event) => {
            if (event.directory !== directory || event.payload?.type !== "message.part.updated") return false
            const properties = event.payload.properties
            if (!isRecord(properties) || !isRecord(properties.part)) return false
            const part = properties.part
            if (part.sessionID !== sessionID || part.type !== "tool" || part.tool !== "read") return false
            return isRecord(part.state) && part.state.status === "running"
          })
          expect(running.payload?.type).toBe("message.part.updated")

          const completed = await stream.next((event) => {
            if (event.directory !== directory || event.payload?.type !== "message.part.updated") return false
            const properties = event.payload.properties
            if (!isRecord(properties) || !isRecord(properties.part)) return false
            const part = properties.part
            if (part.sessionID !== sessionID || part.type !== "tool" || part.tool !== "read") return false
            return (
              isRecord(part.state) &&
              part.state.status === "completed" &&
              typeof part.state.output === "string" &&
              part.state.output.includes(fileText)
            )
          })
          expect(completed.payload?.type).toBe("message.part.updated")

          await request
        })

        const messages = await json<Json[]>(`/session/${sessionID}/message`, { query: sessionQuery() })
        const toolPart = messages
          .flatMap((message) => (Array.isArray(message.parts) ? message.parts : []))
          .find((part) => {
            if (!isRecord(part) || part.type !== "tool" || part.tool !== "read") return false
            return (
              isRecord(part.state) &&
              part.state.status === "completed" &&
              typeof part.state.output === "string" &&
              part.state.output.includes(fileText)
            )
          })
        expect(toolPart).toBeTruthy()

        const sessionJsonl = await readFile(
          join(directory!, ".agents", "atree", "sessions", sessionID, "session.jsonl"),
          "utf8",
        )
        const entries = sessionJsonl
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as Json)
        const toolResult = entries.find((entry) => {
          if (entry.type !== "message" || !isRecord(entry.message)) return false
          if (entry.message.role !== "toolResult" || entry.message.toolName !== "read") return false
          if (!Array.isArray(entry.message.content)) return false
          return entry.message.content.some(
            (part) =>
              isRecord(part) && part.type === "text" && typeof part.text === "string" && part.text.includes(fileText),
          )
        })
        expect(toolResult).toBeTruthy()
      } finally {
        await deleteSession(sessionID)
      }
    })

    test("executes Pi built-in write tool through faux model and persists the tool result", async () => {
      const created = await createSession()
      const sessionID = String(created.id)
      const text = "contract pi write tool prompt"
      const fileText = "atree builtin write contract content"

      try {
        await withEventStream(async (stream) => {
          await stream.next((event) => event.payload?.type === "server.connected")

          const request = json<unknown>(`/session/${sessionID}/prompt_async`, {
            method: "POST",
            query: sessionQuery(),
            body: JSON.stringify({
              parts: [{ type: "text", text }],
            }),
          })

          const running = await stream.next((event) => {
            if (event.directory !== directory || event.payload?.type !== "message.part.updated") return false
            const properties = event.payload.properties
            if (!isRecord(properties) || !isRecord(properties.part)) return false
            const part = properties.part
            if (part.sessionID !== sessionID || part.type !== "tool" || part.tool !== "write") return false
            return isRecord(part.state) && part.state.status === "running"
          })
          expect(running.payload?.type).toBe("message.part.updated")

          const completed = await stream.next((event) => {
            if (event.directory !== directory || event.payload?.type !== "message.part.updated") return false
            const properties = event.payload.properties
            if (!isRecord(properties) || !isRecord(properties.part)) return false
            const part = properties.part
            if (part.sessionID !== sessionID || part.type !== "tool" || part.tool !== "write") return false
            return (
              isRecord(part.state) &&
              part.state.status === "completed" &&
              typeof part.state.output === "string" &&
              part.state.output.includes("Successfully wrote") &&
              part.state.output.includes("contract-write.txt")
            )
          })
          expect(completed.payload?.type).toBe("message.part.updated")

          await request
        })

        expect(await readFile(join(directory!, "contract-write.txt"), "utf8")).toBe(`${fileText}\n`)

        const messages = await json<Json[]>(`/session/${sessionID}/message`, { query: sessionQuery() })
        const toolPart = messages
          .flatMap((message) => (Array.isArray(message.parts) ? message.parts : []))
          .find((part) => {
            if (!isRecord(part) || part.type !== "tool" || part.tool !== "write") return false
            return (
              isRecord(part.state) &&
              part.state.status === "completed" &&
              typeof part.state.output === "string" &&
              part.state.output.includes("Successfully wrote") &&
              part.state.output.includes("contract-write.txt")
            )
          })
        expect(toolPart).toBeTruthy()

        const sessionJsonl = await readFile(
          join(directory!, ".agents", "atree", "sessions", sessionID, "session.jsonl"),
          "utf8",
        )
        const entries = sessionJsonl
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as Json)
        const toolResult = entries.find((entry) => {
          if (entry.type !== "message" || !isRecord(entry.message)) return false
          if (entry.message.role !== "toolResult" || entry.message.toolName !== "write") return false
          if (entry.message.toolCallId !== "tool_contract_write" || !Array.isArray(entry.message.content)) return false
          return entry.message.content.some(
            (part) =>
              isRecord(part) &&
              part.type === "text" &&
              typeof part.text === "string" &&
              part.text.includes("contract-write.txt"),
          )
        })
        expect(toolResult).toBeTruthy()
      } finally {
        await deleteSession(sessionID)
      }
    })

    test("executes Pi built-in edit tool through faux model and persists the tool result", async () => {
      const created = await createSession()
      const sessionID = String(created.id)
      const text = "contract pi edit tool prompt"

      try {
        await writeFile(join(directory!, "contract-edit.txt"), "line one\nbefore edit\nline three\n", "utf8")

        await withEventStream(async (stream) => {
          await stream.next((event) => event.payload?.type === "server.connected")

          const request = json<unknown>(`/session/${sessionID}/prompt_async`, {
            method: "POST",
            query: sessionQuery(),
            body: JSON.stringify({
              parts: [{ type: "text", text }],
            }),
          })

          const running = await stream.next((event) => {
            if (event.directory !== directory || event.payload?.type !== "message.part.updated") return false
            const properties = event.payload.properties
            if (!isRecord(properties) || !isRecord(properties.part)) return false
            const part = properties.part
            if (part.sessionID !== sessionID || part.type !== "tool" || part.tool !== "edit") return false
            return isRecord(part.state) && part.state.status === "running"
          })
          expect(running.payload?.type).toBe("message.part.updated")

          const completed = await stream.next((event) => {
            if (event.directory !== directory || event.payload?.type !== "message.part.updated") return false
            const properties = event.payload.properties
            if (!isRecord(properties) || !isRecord(properties.part)) return false
            const part = properties.part
            if (part.sessionID !== sessionID || part.type !== "tool" || part.tool !== "edit") return false
            return (
              isRecord(part.state) &&
              part.state.status === "completed" &&
              typeof part.state.output === "string" &&
              part.state.output.includes("Successfully replaced") &&
              part.state.output.includes("contract-edit.txt")
            )
          })
          expect(completed.payload?.type).toBe("message.part.updated")

          await request
        })

        expect(await readFile(join(directory!, "contract-edit.txt"), "utf8")).toBe("line one\nafter edit\nline three\n")

        const messages = await json<Json[]>(`/session/${sessionID}/message`, { query: sessionQuery() })
        const toolPart = messages
          .flatMap((message) => (Array.isArray(message.parts) ? message.parts : []))
          .find((part) => {
            if (!isRecord(part) || part.type !== "tool" || part.tool !== "edit") return false
            return (
              isRecord(part.state) &&
              part.state.status === "completed" &&
              typeof part.state.output === "string" &&
              part.state.output.includes("Successfully replaced") &&
              part.state.output.includes("contract-edit.txt")
            )
          })
        expect(toolPart).toBeTruthy()

        const sessionJsonl = await readFile(
          join(directory!, ".agents", "atree", "sessions", sessionID, "session.jsonl"),
          "utf8",
        )
        const entries = sessionJsonl
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as Json)
        const toolResult = entries.find((entry) => {
          if (entry.type !== "message" || !isRecord(entry.message)) return false
          if (entry.message.role !== "toolResult" || entry.message.toolName !== "edit") return false
          if (entry.message.toolCallId !== "tool_contract_edit" || !Array.isArray(entry.message.content)) return false
          return entry.message.content.some(
            (part) =>
              isRecord(part) &&
              part.type === "text" &&
              typeof part.text === "string" &&
              part.text.includes("contract-edit.txt"),
          )
        })
        expect(toolResult).toBeTruthy()
      } finally {
        await deleteSession(sessionID)
      }
    })

    test("executes Pi built-in bash tool through faux model and persists command output", async () => {
      const created = await createSession()
      const sessionID = String(created.id)
      const text = "contract pi bash tool prompt"
      const outputText = "atree-bash-contract-output"

      try {
        await withEventStream(async (stream) => {
          await stream.next((event) => event.payload?.type === "server.connected")

          const request = json<unknown>(`/session/${sessionID}/prompt_async`, {
            method: "POST",
            query: sessionQuery(),
            body: JSON.stringify({
              parts: [{ type: "text", text }],
            }),
          })

          const running = await stream.next((event) => {
            if (event.directory !== directory || event.payload?.type !== "message.part.updated") return false
            const properties = event.payload.properties
            if (!isRecord(properties) || !isRecord(properties.part)) return false
            const part = properties.part
            if (part.sessionID !== sessionID || part.type !== "tool" || part.tool !== "bash") return false
            return isRecord(part.state) && part.state.status === "running"
          })
          expect(running.payload?.type).toBe("message.part.updated")

          const completed = await stream.next((event) => {
            if (event.directory !== directory || event.payload?.type !== "message.part.updated") return false
            const properties = event.payload.properties
            if (!isRecord(properties) || !isRecord(properties.part)) return false
            const part = properties.part
            if (part.sessionID !== sessionID || part.type !== "tool" || part.tool !== "bash") return false
            return (
              isRecord(part.state) &&
              part.state.status === "completed" &&
              typeof part.state.output === "string" &&
              part.state.output.includes(outputText)
            )
          })
          expect(completed.payload?.type).toBe("message.part.updated")

          await request
        })

        const messages = await json<Json[]>(`/session/${sessionID}/message`, { query: sessionQuery() })
        const toolPart = messages
          .flatMap((message) => (Array.isArray(message.parts) ? message.parts : []))
          .find((part) => {
            if (!isRecord(part) || part.type !== "tool" || part.tool !== "bash") return false
            return (
              isRecord(part.state) &&
              part.state.status === "completed" &&
              typeof part.state.output === "string" &&
              part.state.output.includes(outputText)
            )
          })
        expect(toolPart).toBeTruthy()

        const sessionJsonl = await readFile(
          join(directory!, ".agents", "atree", "sessions", sessionID, "session.jsonl"),
          "utf8",
        )
        const entries = sessionJsonl
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as Json)
        const toolResult = entries.find((entry) => {
          if (entry.type !== "message" || !isRecord(entry.message)) return false
          if (entry.message.role !== "toolResult" || entry.message.toolName !== "bash") return false
          if (entry.message.toolCallId !== "tool_contract_bash" || !Array.isArray(entry.message.content)) return false
          return entry.message.content.some(
            (part) =>
              isRecord(part) && part.type === "text" && typeof part.text === "string" && part.text.includes(outputText),
          )
        })
        expect(toolResult).toBeTruthy()
      } finally {
        await deleteSession(sessionID)
      }
    })
  })

if (isRealPiSuccessContract)
  describe("atree real Pi execution success contract", () => {
    beforeAll(async () => {
      await ensureTestDirectory()
      const health = await json<Json>("/global/health")
      expect(health.healthy).toBe(true)
    })

    afterAll(async () => {
      if (cleanupDirectory && directory) await rm(directory, { recursive: true, force: true })
    })

    test("runs prompt_async through the configured real Pi model and persists assistant output", async () => {
      const created = await createSession()
      const sessionID = String(created.id)
      const text = "Reply briefly with the phrase: atree real pi contract ok"

      try {
        await withEventStream(async (stream) => {
          await stream.next((event) => event.payload?.type === "server.connected")

          const request = json<unknown>(`/session/${sessionID}/prompt_async`, {
            method: "POST",
            query: sessionQuery(),
            body: JSON.stringify({
              parts: [{ type: "text", text }],
            }),
          })

          const busy = await stream.next((event) => {
            if (event.directory !== directory || event.payload?.type !== "session.status") return false
            const properties = event.payload.properties
            return (
              isRecord(properties) &&
              properties.sessionID === sessionID &&
              isRecord(properties.status) &&
              properties.status.type === "busy"
            )
          })
          expect(busy.payload?.type).toBe("session.status")

          await request

          const idle = await stream.next((event) => {
            if (event.directory !== directory || event.payload?.type !== "session.status") return false
            const properties = event.payload.properties
            return (
              isRecord(properties) &&
              properties.sessionID === sessionID &&
              isRecord(properties.status) &&
              properties.status.type === "idle"
            )
          })
          expect(idle.payload?.type).toBe("session.status")
        })

        const messages = await json<Json[]>(`/session/${sessionID}/message`, { query: sessionQuery() })
        const assistant = messages.find((message) => {
          if (!isRecord(message.info) || message.info.role !== "assistant") return false
          if (!Array.isArray(message.parts)) return false
          return message.parts.some(
            (part) => isRecord(part) && part.type === "text" && typeof part.text === "string" && part.text.length > 0,
          )
        })
        expect(assistant).toBeTruthy()

        const sessionJsonl = await readFile(
          join(directory!, ".agents", "atree", "sessions", sessionID, "session.jsonl"),
          "utf8",
        )
        const entries = sessionJsonl
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as Json)
        const userEntry = entries.find((entry) => {
          if (entry.type !== "message" || !isRecord(entry.message)) return false
          if (entry.message.role !== "user" || !Array.isArray(entry.message.content)) return false
          return entry.message.content.some((part) => isRecord(part) && part.type === "text" && part.text === text)
        })
        expect(userEntry).toBeTruthy()

        const assistantEntry = entries.find((entry) => {
          if (entry.type !== "message" || !isRecord(entry.message)) return false
          if (entry.message.role !== "assistant" || !Array.isArray(entry.message.content)) return false
          return entry.message.content.some(
            (part) => isRecord(part) && part.type === "text" && typeof part.text === "string" && part.text.length > 0,
          )
        })
        expect(assistantEntry).toBeTruthy()
      } finally {
        await deleteSession(sessionID)
      }
    })

    test("binds Pi extensions with the configured real Pi model", async () => {
      const created = await createSession()
      const sessionID = String(created.id)
      const text = "Reply briefly with the phrase: atree real pi extension contract ok"
      const eventPath = await installPiLifecycleExtension()

      try {
        await json<unknown>(`/session/${sessionID}/prompt_async`, {
          method: "POST",
          query: sessionQuery(),
          body: JSON.stringify({
            parts: [{ type: "text", text }],
          }),
        })

        await readLifecycleExtensionEvents(eventPath, text)

        const messages = await json<Json[]>(`/session/${sessionID}/message`, { query: sessionQuery() })
        const assistant = messages.find((message) => {
          if (!isRecord(message.info) || message.info.role !== "assistant") return false
          if (!Array.isArray(message.parts)) return false
          return message.parts.some(
            (part) => isRecord(part) && part.type === "text" && typeof part.text === "string" && part.text.length > 0,
          )
        })
        expect(assistant).toBeTruthy()
      } finally {
        await deleteSession(sessionID)
        await cleanupPiLifecycleExtension()
      }
    })

    test("runs due at schedules through the configured real Pi model", async () => {
      const created = await createSession()
      const sessionID = String(created.id)
      const text = "Reply briefly with the phrase: atree real pi schedule contract ok"
      let scheduleID = ""

      try {
        await withEventStream(async (stream) => {
          await stream.next((event) => event.payload?.type === "server.connected")

          const schedule = await json<Json>(`/session/${sessionID}/schedule`, {
            method: "POST",
            query: sessionQuery(),
            body: JSON.stringify({
              type: "at",
              at: Date.now() + 250,
              message: text,
            }),
          })
          scheduleID = String(schedule.id)

          await stream.next((event) => {
            if (event.directory !== directory || event.payload?.type !== "session.status") return false
            const properties = event.payload.properties
            return (
              isRecord(properties) &&
              properties.sessionID === sessionID &&
              isRecord(properties.status) &&
              properties.status.type === "busy"
            )
          }, 15_000)

          const ran = await stream.next((event) => {
            if (event.directory !== directory || event.payload?.type !== "schedule.ran") return false
            const properties = event.payload.properties
            return (
              isRecord(properties) &&
              properties.sessionID === sessionID &&
              properties.scheduleID === scheduleID &&
              properties.status === "ran"
            )
          }, 30_000)
          expect(ran.payload?.type).toBe("schedule.ran")

          await stream.next((event) => {
            if (event.directory !== directory || event.payload?.type !== "schedule.deleted") return false
            const properties = event.payload.properties
            return isRecord(properties) && properties.sessionID === sessionID && properties.scheduleID === scheduleID
          })
        })

        const schedules = await json<Json[]>(`/session/${sessionID}/schedule`, { query: sessionQuery() })
        expect(schedules).toHaveLength(0)

        const messages = await json<Json[]>(`/session/${sessionID}/message`, { query: sessionQuery() })
        const scheduledUser = messages.find((message) => {
          if (!isRecord(message.info) || message.info.role !== "user" || message.info.agent !== "automation")
            return false
          if (!Array.isArray(message.parts)) return false
          return message.parts.some((part) => isRecord(part) && part.type === "text" && part.text === text)
        })
        expect(scheduledUser).toBeTruthy()

        const assistant = messages.find((message) => {
          if (!isRecord(message.info) || message.info.role !== "assistant") return false
          if (!Array.isArray(message.parts)) return false
          return message.parts.some(
            (part) => isRecord(part) && part.type === "text" && typeof part.text === "string" && part.text.length > 0,
          )
        })
        expect(assistant).toBeTruthy()

        const sessionJsonl = await readFile(
          join(directory!, ".agents", "atree", "sessions", sessionID, "session.jsonl"),
          "utf8",
        )
        const entries = sessionJsonl
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as Json)
        const userEntry = entries.find((entry) => {
          if (entry.type !== "message" || !isRecord(entry.message)) return false
          if (entry.message.role !== "user" || !isRecord(entry.message.source)) return false
          if (entry.message.source.type !== "schedule" || entry.message.source.scheduleID !== scheduleID) return false
          if (!Array.isArray(entry.message.content)) return false
          return entry.message.content.some((part) => isRecord(part) && part.type === "text" && part.text === text)
        })
        expect(userEntry).toBeTruthy()

        const assistantEntry = entries.find((entry) => {
          if (entry.type !== "message" || !isRecord(entry.message)) return false
          if (entry.message.role !== "assistant" || !Array.isArray(entry.message.content)) return false
          return entry.message.content.some(
            (part) => isRecord(part) && part.type === "text" && typeof part.text === "string" && part.text.length > 0,
          )
        })
        expect(assistantEntry).toBeTruthy()
      } finally {
        await deleteSession(sessionID)
      }
    })
  })

if (process.env.ATREE_PI_REAL_ERROR_CONTRACT === "1")
  describe("atree real Pi execution error contract", () => {
    beforeAll(async () => {
      await ensureTestDirectory()
      const health = await json<Json>("/global/health")
      expect(health.healthy).toBe(true)
    })

    afterAll(async () => {
      if (cleanupDirectory && directory) await rm(directory, { recursive: true, force: true })
    })

    test("emits an error and returns to idle when real Pi execution is not configured", async () => {
      const created = await createSession()
      const sessionID = String(created.id)

      try {
        await withEventStream(async (stream) => {
          await stream.next((event) => event.payload?.type === "server.connected")

          const request = json<unknown>(`/session/${sessionID}/prompt_async`, {
            method: "POST",
            query: sessionQuery(),
            body: JSON.stringify({
              parts: [{ type: "text", text: "contract real pi missing config prompt" }],
            }),
          }).catch((error) => error)

          await stream.next((event) => {
            if (event.directory !== directory || event.payload?.type !== "session.status") return false
            const properties = event.payload.properties
            return (
              isRecord(properties) &&
              properties.sessionID === sessionID &&
              isRecord(properties.status) &&
              properties.status.type === "busy"
            )
          })

          const error = await stream.next((event) => {
            if (event.directory !== directory || event.payload?.type !== "session.error") return false
            const properties = event.payload.properties
            return isRecord(properties) && properties.sessionID === sessionID && isRecord(properties.error)
          })
          expect(error.payload?.type).toBe("session.error")

          const idle = await stream.next((event) => {
            if (event.directory !== directory || event.payload?.type !== "session.status") return false
            const properties = event.payload.properties
            return (
              isRecord(properties) &&
              properties.sessionID === sessionID &&
              isRecord(properties.status) &&
              properties.status.type === "idle"
            )
          })
          expect(idle.payload?.type).toBe("session.status")

          expect(await request).toBeInstanceOf(Error)
        })
      } finally {
        await deleteSession(sessionID)
      }
    })

    test("marks due schedules skipped and returns to idle when real Pi execution is not configured", async () => {
      const created = await createSession()
      const sessionID = String(created.id)
      let scheduleID = ""

      try {
        await withEventStream(async (stream) => {
          await stream.next((event) => event.payload?.type === "server.connected")

          const schedule = await json<Json>(`/session/${sessionID}/schedule`, {
            method: "POST",
            query: sessionQuery(),
            body: JSON.stringify({
              type: "at",
              at: Date.now() + 250,
              message: "contract real pi missing config scheduled prompt",
            }),
          })
          scheduleID = String(schedule.id)

          await stream.next((event) => {
            if (event.directory !== directory || event.payload?.type !== "session.status") return false
            const properties = event.payload.properties
            return (
              isRecord(properties) &&
              properties.sessionID === sessionID &&
              isRecord(properties.status) &&
              properties.status.type === "busy"
            )
          })

          const skipped = await stream.next((event) => {
            if (event.directory !== directory || event.payload?.type !== "schedule.ran") return false
            const properties = event.payload.properties
            return (
              isRecord(properties) &&
              properties.sessionID === sessionID &&
              properties.scheduleID === scheduleID &&
              properties.status === "skipped"
            )
          })
          expect(skipped.payload?.type).toBe("schedule.ran")

          const deleted = await stream.next((event) => {
            if (event.directory !== directory || event.payload?.type !== "schedule.deleted") return false
            const properties = event.payload.properties
            return isRecord(properties) && properties.sessionID === sessionID && properties.scheduleID === scheduleID
          })
          expect(deleted.payload?.type).toBe("schedule.deleted")

          const error = await stream.next((event) => {
            if (event.directory !== directory || event.payload?.type !== "session.error") return false
            const properties = event.payload.properties
            return (
              isRecord(properties) &&
              properties.sessionID === sessionID &&
              properties.scheduleID === scheduleID &&
              isRecord(properties.error)
            )
          })
          expect(error.payload?.type).toBe("session.error")

          const idle = await stream.next((event) => {
            if (event.directory !== directory || event.payload?.type !== "session.status") return false
            const properties = event.payload.properties
            return (
              isRecord(properties) &&
              properties.sessionID === sessionID &&
              isRecord(properties.status) &&
              properties.status.type === "idle"
            )
          })
          expect(idle.payload?.type).toBe("session.status")
        })

        const schedules = await json<Json[]>(`/session/${sessionID}/schedule`, { query: sessionQuery() })
        expect(schedules).toHaveLength(0)
      } finally {
        await deleteSession(sessionID)
      }
    })
  })
