import { DateTime } from "effect"
import { createHash } from "crypto"
import fs from "fs/promises"
import path from "path"
import { AgentV2 } from "../agent"
import { Global } from "../global"
import { Location } from "../location"
import { ModelV2 } from "../model"
import { ProjectV2 } from "../project"
import { ProviderV2 } from "../provider"
import { AbsolutePath, RelativePath } from "../schema"
import type { SessionInput } from "../session/input"
import { SessionMessage } from "../session/message"
import { AgentAttachment, FileAttachment, Prompt } from "../session/prompt"
import { SessionSchema } from "../session/schema"
import { WorkspaceV2 } from "../workspace"

const FindMaxDepth = 8
const FindMaxNodes = 2_000
const IgnoredDirectories = new Set([
  ".agents",
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  ".next",
  ".turbo",
  ".cache",
  "dist",
  "build",
])

function stateFile() {
  return path.join(Global.Path.data, "atree", "state.json")
}

function parseValue(value: string) {
  const trimmed = value.trim()
  if (trimmed === "") return undefined
  try {
    return JSON.parse(trimmed)
  } catch {
    return trimmed
  }
}

function baseEventType(value: unknown) {
  if (typeof value !== "string") return
  return value.replace(/\.\d+$/, "")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function isSessionMessageEvent(type: string | undefined) {
  if (!type) return false
  return (
    type.startsWith("message.") ||
    type === "session.next.prompted" ||
    type === "session.next.prompt.admitted" ||
    type === "session.next.prompt.promoted" ||
    type === "session.next.context.updated" ||
    type === "session.next.synthetic" ||
    type.startsWith("session.next.step.") ||
    type.startsWith("session.next.text.") ||
    type.startsWith("session.next.reasoning.") ||
    type.startsWith("session.next.tool.") ||
    type.startsWith("session.next.shell.") ||
    type.startsWith("session.next.compaction.")
  )
}

function parseMeta(raw: string, fallbackDirectory: string): SessionSchema.Info | undefined {
  const data: Record<string, unknown> = {}
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z][A-Za-z0-9]*):\s*(.*)$/)
    if (!match) continue
    data[match[1]] = parseValue(match[2] ?? "")
  }

  if (typeof data.id !== "string") return
  const created = typeof data.createdAt === "number" ? data.createdAt : 0
  const updated = typeof data.updatedAt === "number" ? data.updatedAt : created
  const archived = typeof data.archivedAt === "number" ? data.archivedAt : undefined
  return SessionSchema.Info.make({
    id: SessionSchema.ID.make(data.id),
    parentID: typeof data.parentID === "string" ? SessionSchema.ID.make(data.parentID) : undefined,
    projectID: ProjectV2.ID.make(typeof data.projectID === "string" ? data.projectID : "global"),
    title: typeof data.title === "string" ? data.title : data.id,
    agent: typeof data.agent === "string" ? AgentV2.ID.make(data.agent) : undefined,
    model: modelRef(data.model),
    cost: typeof data.cost === "number" ? data.cost : 0,
    tokens:
      data.tokens && typeof data.tokens === "object"
        ? (data.tokens as SessionSchema.Info["tokens"])
        : { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    location: Location.Ref.make({
      directory: AbsolutePath.make(fallbackDirectory),
      workspaceID: typeof data.workspaceID === "string" ? WorkspaceV2.ID.make(data.workspaceID) : undefined,
    }),
    subpath: typeof data.path === "string" ? RelativePath.make(data.path) : undefined,
    time: {
      created: DateTime.makeUnsafe(created),
      updated: DateTime.makeUnsafe(updated),
      archived: archived === undefined ? undefined : DateTime.makeUnsafe(archived),
    },
  })
}

async function applySessionUpdatedEvents(info: SessionSchema.Info) {
  const raw = await fs.readFile(sessionJsonl(info), "utf8").catch((error: unknown) => {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return ""
    throw error
  })
  let next = info
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue
    let entry: Record<string, unknown>
    try {
      entry = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    const type = baseEventType(entry.type)
    const data = eventData(entry)
    if (type === "session.next.agent.switched" && typeof data.agent === "string") {
      const updated = timestampValue(data.timestamp, typeof entry.at === "number" ? entry.at : 0)
      next = SessionSchema.Info.make({
        ...next,
        agent: AgentV2.ID.make(data.agent),
        time: {
          ...next.time,
          updated: DateTime.makeUnsafe(Math.max(DateTime.toEpochMillis(next.time.updated), updated)),
        },
      })
      continue
    }
    if (type === "session.next.model.switched") {
      const model = modelRef(data.model)
      if (!model) continue
      const updated = timestampValue(data.timestamp, typeof entry.at === "number" ? entry.at : 0)
      next = SessionSchema.Info.make({
        ...next,
        model,
        time: {
          ...next.time,
          updated: DateTime.makeUnsafe(Math.max(DateTime.toEpochMillis(next.time.updated), updated)),
        },
      })
      continue
    }
    if (type === "session.next.moved") {
      const location = isRecord(data.location) ? data.location : undefined
      const updated = timestampValue(data.timestamp, typeof entry.at === "number" ? entry.at : 0)
      next = SessionSchema.Info.make({
        ...next,
        location: Location.Ref.make({
          directory: next.location.directory,
          workspaceID:
            typeof location?.workspaceID === "string"
              ? WorkspaceV2.ID.make(location.workspaceID)
              : next.location.workspaceID,
        }),
        subpath: typeof data.subdirectory === "string" ? RelativePath.make(data.subdirectory) : next.subpath,
        time: {
          ...next.time,
          updated: DateTime.makeUnsafe(Math.max(DateTime.toEpochMillis(next.time.updated), updated)),
        },
      })
      continue
    }
    if (type !== "session.updated") continue
    const patch = isRecord(data.patch) ? data.patch : isRecord(data.info) ? data.info : undefined
    if (!patch) continue
    const time = { ...next.time }
    if (isRecord(patch.time)) {
      if (typeof patch.time.created === "number") {
        time.created = DateTime.makeUnsafe(patch.time.created)
      }
      if ("archived" in patch.time) {
        const archived = patch.time.archived
        if (typeof archived === "number") time.archived = DateTime.makeUnsafe(archived)
        else if (archived === null) delete time.archived
      }
      if (typeof patch.time.updated === "number") {
        time.updated = DateTime.makeUnsafe(
          Math.max(DateTime.toEpochMillis(time.updated), patch.time.updated),
        )
      }
    }
    if (typeof entry.at === "number") {
      time.updated = DateTime.makeUnsafe(Math.max(DateTime.toEpochMillis(time.updated), entry.at))
    }
    const location = isRecord(patch.location) ? patch.location : undefined
    const tokens = tokensValue(patch.tokens)
    next = SessionSchema.Info.make({
      ...next,
      ...(typeof patch.projectID === "string" ? { projectID: ProjectV2.ID.make(patch.projectID) } : {}),
      ...("parentID" in patch
        ? {
            parentID: typeof patch.parentID === "string" ? SessionSchema.ID.make(patch.parentID) : undefined,
          }
        : {}),
      ...(typeof patch.title === "string" ? { title: patch.title } : {}),
      ...("agent" in patch
        ? {
            agent: typeof patch.agent === "string" ? AgentV2.ID.make(patch.agent) : undefined,
          }
        : {}),
      ...("model" in patch ? { model: modelRef(patch.model) } : {}),
      ...(typeof patch.cost === "number" ? { cost: patch.cost } : {}),
      ...(tokens ? { tokens } : {}),
      ...("workspaceID" in patch
        ? {
            location: Location.Ref.make({
              directory: next.location.directory,
              workspaceID: typeof patch.workspaceID === "string" ? WorkspaceV2.ID.make(patch.workspaceID) : undefined,
            }),
          }
        : typeof location?.workspaceID === "string"
          ? {
              location: Location.Ref.make({
                directory: next.location.directory,
                workspaceID: WorkspaceV2.ID.make(location.workspaceID),
              }),
            }
          : {}),
      ...(typeof patch.subpath === "string"
        ? { subpath: RelativePath.make(patch.subpath) }
        : typeof patch.path === "string"
          ? { subpath: RelativePath.make(patch.path) }
        : {}),
      time,
    })
  }
  return next
}

function sessionInfoFromCreatedEvent(
  entry: Record<string, unknown>,
  fallbackDirectory: string,
  fallbackSessionID: SessionSchema.ID,
) {
  const data = eventData(entry)
  if (baseEventType(entry.type) !== "session.created" || !isRecord(data.info)) return
  const info = data.info
  const id = typeof info.id === "string" ? info.id : fallbackSessionID
  if (id !== fallbackSessionID) return
  const time = isRecord(info.time) ? info.time : {}
  const location = isRecord(info.location) ? info.location : {}
  const eventAt = timestampValue(data.at, timestampValue(entry.at, 0))
  const created = timestampValue(time.created, eventAt)
  const updated = timestampValue(time.updated, eventAt || created)
  const archived = "archived" in time ? timestampValue(time.archived, Number.NaN) : Number.NaN
  return SessionSchema.Info.make({
    id: fallbackSessionID,
    parentID: typeof info.parentID === "string" ? SessionSchema.ID.make(info.parentID) : undefined,
    projectID: ProjectV2.ID.make(typeof info.projectID === "string" ? info.projectID : "global"),
    title: typeof info.title === "string" ? info.title : id,
    agent: typeof info.agent === "string" ? AgentV2.ID.make(info.agent) : undefined,
    model: modelRef(info.model),
    cost: typeof info.cost === "number" ? info.cost : 0,
    tokens:
      info.tokens && typeof info.tokens === "object"
        ? (info.tokens as SessionSchema.Info["tokens"])
        : { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    location: Location.Ref.make({
      directory: AbsolutePath.make(fallbackDirectory),
      workspaceID: typeof location.workspaceID === "string" ? WorkspaceV2.ID.make(location.workspaceID) : undefined,
    }),
    subpath: typeof info.subpath === "string" ? RelativePath.make(info.subpath) : undefined,
    time: {
      created: DateTime.makeUnsafe(created),
      updated: DateTime.makeUnsafe(updated),
      archived: Number.isFinite(archived) ? DateTime.makeUnsafe(archived) : undefined,
    },
  })
}

async function readSessionCreatedEvent(directory: string, sessionID: SessionSchema.ID) {
  const raw = await fs
    .readFile(path.join(sessionRootByID(directory, sessionID), "session.jsonl"), "utf8")
    .catch((error: unknown) => {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return ""
      throw error
    })
  let created: SessionSchema.Info | undefined
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue
    let entry: Record<string, unknown>
    try {
      entry = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    created = sessionInfoFromCreatedEvent(entry, directory, sessionID) ?? created
  }
  return created ? applySessionUpdatedEvents(created) : undefined
}

export async function readWorkspaceRoot() {
  try {
    const raw = await fs.readFile(stateFile(), "utf8")
    const parsed = JSON.parse(raw) as { rootDirectory?: unknown }
    return typeof parsed.rootDirectory === "string" ? parsed.rootDirectory : undefined
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return
    throw error
  }
}

export async function hasSessionJsonlMessageEvents(info: SessionSchema.Info) {
  const raw = await fs.readFile(sessionJsonl(info), "utf8").catch((error: unknown) => {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return ""
    throw error
  })
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const entry = JSON.parse(line) as Record<string, unknown>
      if (isSessionMessageEvent(baseEventType(entry.type))) return true
    } catch {
      continue
    }
  }
  return false
}

export async function readSessionStore(directory: string, sessionID: SessionSchema.ID) {
  const target = path.join(directory, ".agents", "atree", "sessions", sessionID, "meta.yaml")
  const raw = await fs.readFile(target, "utf8").catch((error: unknown) => {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined
    throw error
  })
  if (!raw) return readSessionCreatedEvent(directory, sessionID)
  const parsed = parseMeta(raw, directory)
  if (!parsed) return
  return applySessionUpdatedEvents(parsed)
}

export async function readSessionStores(directory: string) {
  const root = path.join(directory, ".agents", "atree", "sessions")
  const entries = await fs.readdir(root, { withFileTypes: true }).catch((error: unknown) => {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return []
    throw error
  })
  const sessions: SessionSchema.Info[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const session = await readSessionStore(directory, SessionSchema.ID.make(entry.name))
    if (session) sessions.push(session)
  }
  sessions.sort(
    (a, b) => DateTime.toEpochMillis(b.time.updated) - DateTime.toEpochMillis(a.time.updated) || b.id.localeCompare(a.id),
  )
  return sessions
}

export async function readSessionStoresDeep(rootDirectory: string) {
  const root = await fs.realpath(rootDirectory)
  const budget = { count: 0 }
  const result: SessionSchema.Info[] = []

  async function walk(directory: string, depth: number): Promise<void> {
    if (budget.count++ >= FindMaxNodes) return
    result.push(...(await readSessionStores(directory)))
    if (depth >= FindMaxDepth) return

    const entries = await fs.readdir(directory, { withFileTypes: true }).catch((error: unknown) => {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        (error.code === "ENOENT" || error.code === "EACCES")
      ) {
        return []
      }
      throw error
    })

    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (IgnoredDirectories.has(entry.name)) continue
      await walk(path.join(directory, entry.name), depth + 1)
    }
  }

  await walk(root, 0)
  result.sort(
    (a, b) => DateTime.toEpochMillis(b.time.updated) - DateTime.toEpochMillis(a.time.updated) || b.id.localeCompare(a.id),
  )
  return result
}

export async function findSessionStore(rootDirectory: string, sessionID: SessionSchema.ID) {
  const root = await fs.realpath(rootDirectory)
  const budget = { count: 0 }

  async function walk(directory: string, depth: number): Promise<SessionSchema.Info | undefined> {
    if (budget.count++ >= FindMaxNodes) return
    const found = await readSessionStore(directory, sessionID)
    if (found) return found
    if (depth >= FindMaxDepth) return

    const entries = await fs.readdir(directory, { withFileTypes: true }).catch((error: unknown) => {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        (error.code === "ENOENT" || error.code === "EACCES")
      ) {
        return []
      }
      throw error
    })

    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (IgnoredDirectories.has(entry.name)) continue
      const result = await walk(path.join(directory, entry.name), depth + 1)
      if (result) return result
    }
  }

  return walk(root, 0)
}

export async function findSessionJsonlMessage(rootDirectory: string, messageID: SessionMessage.ID) {
  const root = await fs.realpath(rootDirectory)
  const budget = { count: 0 }

  async function walk(directory: string, depth: number): Promise<
    | {
        session: SessionSchema.Info
        message: SessionMessage.Message
      }
    | undefined
  > {
    if (budget.count++ >= FindMaxNodes) return
    const sessions = await readSessionStores(directory)
    for (const session of sessions) {
      const messages = await readSessionJsonlMessages(session)
      const message = messages.find((item) => item.id === messageID)
      if (message) return { session, message }
    }
    if (depth >= FindMaxDepth) return

    const entries = await fs.readdir(directory, { withFileTypes: true }).catch((error: unknown) => {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        (error.code === "ENOENT" || error.code === "EACCES")
      ) {
        return []
      }
      throw error
    })

    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (IgnoredDirectories.has(entry.name)) continue
      const result = await walk(path.join(directory, entry.name), depth + 1)
      if (result) return result
    }
  }

  return walk(root, 0)
}

type V1Message = {
  id: string
  role: "user" | "assistant"
  agent?: string
  model?: { providerID?: string; modelID?: string; id?: string; variant?: string }
  time?: { created?: number; completed?: number }
}

type V1Part = {
  id: string
  messageID: string
  type: string
  tool?: string
  callID?: string
  text?: string
  url?: string
  mime?: string
  filename?: string
  name?: string
  description?: string
  metadata?: Record<string, Record<string, unknown>>
  providerMetadata?: Record<string, Record<string, unknown>>
  toolInvocation?: {
    state?: string
    toolCallId?: string
    toolName?: string
    args?: unknown
    result?: unknown
  }
  state?: {
    status?: string
    input?: unknown
    raw?: string
    output?: unknown
    title?: string
    metadata?: Record<string, unknown>
    time?: {
      start?: number
      end?: number
    }
  }
}

type ShellRecord = {
  messageID: string
  callID: string
  command: string
  output: string
  created: number
  completed?: number
}

type CompactionRecord = {
  messageID: string
  reason: "auto" | "manual"
  summary: string
  recent: string
  created: number
}

type DirectMessageRecord =
  | { kind: "agent"; messageID: string; agent: string; created: number }
  | { kind: "model"; messageID: string; model: ModelV2.Ref; created: number }
  | { kind: "system"; messageID: string; text: string; created: number }
  | { kind: "synthetic"; messageID: string; text: string; created: number }

type PromptEventRecord = {
  messageID: string
  text: string
  files?: FileAttachment[]
  agents?: AgentAttachment[]
  created: number
}

type AssistantEventRecord = {
  id: string
  agent: string
  model: ModelV2.Ref
  content: SessionMessage.AssistantContent[]
  created: number
  completed?: number
  finish?: string
  cost?: number
  tokens?: SessionMessage.Assistant["tokens"]
  snapshot?: SessionMessage.Assistant["snapshot"]
  error?: SessionMessage.Assistant["error"]
}

type EventProvider = NonNullable<SessionMessage.AssistantTool["provider"]>

function sessionRoot(info: SessionSchema.Info) {
  return path.join(info.location.directory, ".agents", "atree", "sessions", info.id)
}

function sessionRootByID(directory: string, sessionID: string) {
  return path.join(directory, ".agents", "atree", "sessions", sessionID)
}

function sessionJsonl(info: SessionSchema.Info) {
  return path.join(sessionRoot(info), "session.jsonl")
}

function yamlValue(value: unknown) {
  return JSON.stringify(value ?? null)
}

function metaYaml(info: SessionSchema.Info) {
  return [
    "version: 1",
    `id: ${yamlValue(info.id)}`,
    `slug: ${yamlValue(info.id)}`,
    `sessionVersion: "core"`,
    `projectID: ${yamlValue(info.projectID)}`,
    `workspaceID: ${yamlValue(info.location.workspaceID)}`,
    `path: ${yamlValue(info.subpath)}`,
    `parentID: ${yamlValue(info.parentID)}`,
    `title: ${yamlValue(info.title)}`,
    `agent: ${yamlValue(info.agent)}`,
    `model: ${yamlValue(info.model)}`,
    `createdAt: ${DateTime.toEpochMillis(info.time.created)}`,
    `updatedAt: ${DateTime.toEpochMillis(info.time.updated)}`,
    `archivedAt: ${yamlValue(info.time.archived ? DateTime.toEpochMillis(info.time.archived) : null)}`,
    `cost: ${yamlValue(info.cost)}`,
    `tokens: ${yamlValue(info.tokens)}`,
    "metadata: {}",
    "",
  ].join("\n")
}

async function writeAtomic(target: string, content: string) {
  await fs.mkdir(path.dirname(target), { recursive: true })
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`)
  await fs.writeFile(temp, content)
  await fs.rename(temp, target)
}

async function writeIfMissing(target: string, content: string) {
  await fs.mkdir(path.dirname(target), { recursive: true })
  try {
    await fs.writeFile(target, content, { flag: "wx" })
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") return
    throw error
  }
}

export async function writeSessionStore(info: SessionSchema.Info) {
  await writeIfMissing(path.join(info.location.directory, ".agents", "atree", "meta.yaml"), 'version: 1\nsource: "atree"\n')
  const root = sessionRoot(info)
  await fs.mkdir(path.join(root, "assets"), { recursive: true })
  await writeIfMissing(path.join(root, "session.jsonl"), "")
  await writeAtomic(path.join(root, "meta.yaml"), metaYaml(info))
}

async function exists(target: string) {
  return fs.access(target).then(
    () => true,
    (error: unknown) => {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false
      throw error
    },
  )
}

async function moveDirectory(source: string, destination: string) {
  await fs.mkdir(path.dirname(destination), { recursive: true })
  try {
    await fs.rename(source, destination)
  } catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EXDEV") throw error
    await fs.cp(source, destination, { recursive: true, force: false, errorOnExist: true })
    await fs.rm(source, { recursive: true, force: true })
  }
}

export async function moveSessionStore(
  info: SessionSchema.Info,
  destinationDirectory: string,
  updatedAt = Date.now(),
) {
  const sourceRoot = sessionRoot(info)
  if (!(await exists(sourceRoot))) return
  const next = SessionSchema.Info.make({
    ...info,
    location: Location.Ref.make({
      directory: AbsolutePath.make(destinationDirectory),
      workspaceID: info.location.workspaceID,
    }),
    time: {
      ...info.time,
      updated: DateTime.makeUnsafe(Math.max(DateTime.toEpochMillis(info.time.updated), updatedAt)),
    },
  })
  const destinationRoot = sessionRoot(next)
  if (path.resolve(sourceRoot) !== path.resolve(destinationRoot)) {
    await moveDirectory(sourceRoot, destinationRoot)
  }
  await writeSessionStore(next)
  return next
}

export async function ensureSessionPayloadFilesByID(directory: string, sessionID: string) {
  await writeIfMissing(path.join(directory, ".agents", "atree", "meta.yaml"), 'version: 1\nsource: "atree"\n')
  const root = sessionRootByID(directory, sessionID)
  await fs.mkdir(path.join(root, "assets"), { recursive: true })
  await writeIfMissing(path.join(root, "session.jsonl"), "")
}

export async function touchSessionStore(
  directory: string,
  sessionID: SessionSchema.ID,
  updatedAt = Date.now(),
) {
  const session = await readSessionStore(directory, sessionID)
  if (!session) return false
  await writeSessionStore({
    ...session,
    time: {
      ...session.time,
      updated: DateTime.makeUnsafe(updatedAt),
    },
  })
  return true
}

function promptPartID(messageID: SessionMessage.ID) {
  return `prt_${messageID.replace(/^msg_?/, "")}_text`
}

async function appendJsonl(target: string, entries: Record<string, unknown>[]) {
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.appendFile(target, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n")
}

export async function appendSessionJsonl(info: SessionSchema.Info, entry: Record<string, unknown>) {
  await appendJsonl(sessionJsonl(info), [{ version: 1, at: Date.now(), ...entry }])
}

async function writeBufferIfMissing(target: string, content: Buffer) {
  try {
    await fs.writeFile(target, content, { flag: "wx" })
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") return
    throw error
  }
}

function messageCreated(message: V1Message, fallback: number) {
  return typeof message.time?.created === "number" ? message.time.created : fallback
}

function timestampValue(value: unknown, fallback: number) {
  if (typeof value === "number") return value
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>
    if (typeof record.epochMillis === "number") return record.epochMillis
    if (typeof record.millis === "number") return record.millis
  }
  return fallback
}

function eventData(entry: Record<string, unknown>) {
  return entry.data && typeof entry.data === "object" ? (entry.data as Record<string, unknown>) : entry
}

function modelRef(value: unknown): ModelV2.Ref | undefined {
  if (!value || typeof value !== "object") return
  const model = value as { id?: unknown; modelID?: unknown; providerID?: unknown; variant?: unknown }
  const id = typeof model.id === "string" ? model.id : typeof model.modelID === "string" ? model.modelID : undefined
  if (typeof id !== "string" || typeof model.providerID !== "string") return
  return {
    id: ModelV2.ID.make(id),
    providerID: ProviderV2.ID.make(model.providerID),
    variant: ModelV2.VariantID.make(typeof model.variant === "string" ? model.variant : "default"),
  }
}

function tokensValue(value: unknown): SessionMessage.Assistant["tokens"] | undefined {
  if (!value || typeof value !== "object") return
  const tokens = value as { input?: unknown; output?: unknown; reasoning?: unknown; cache?: unknown }
  const cache = tokens.cache && typeof tokens.cache === "object" ? (tokens.cache as { read?: unknown; write?: unknown }) : {}
  if (
    typeof tokens.input !== "number" ||
    typeof tokens.output !== "number" ||
    typeof tokens.reasoning !== "number" ||
    typeof cache.read !== "number" ||
    typeof cache.write !== "number"
  ) {
    return
  }
  return {
    input: tokens.input,
    output: tokens.output,
    reasoning: tokens.reasoning,
    cache: { read: cache.read, write: cache.write },
  }
}

function unknownError(value: unknown): SessionMessage.Assistant["error"] | undefined {
  if (value && typeof value === "object") {
    const error = value as { type?: unknown; message?: unknown }
    if (error.type === "unknown" && typeof error.message === "string") return { type: "unknown", message: error.message }
  }
  return
}

function eventProvider(value: unknown): EventProvider {
  if (!value || typeof value !== "object") return { executed: false }
  const provider = value as { executed?: unknown; metadata?: unknown }
  const executed = typeof provider.executed === "boolean" ? provider.executed : false
  return {
    executed,
    metadata:
      provider.metadata && typeof provider.metadata === "object"
        ? (provider.metadata as Record<string, Record<string, unknown>>)
        : undefined,
  }
}

function eventContent(value: unknown): SessionMessage.ToolStateRunning["content"] {
  return Array.isArray(value) ? (value as SessionMessage.ToolStateRunning["content"]) : []
}

function eventStructured(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>
  return {}
}

function eventOutputPaths(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}

function updateAssistantEventTool(
  assistant: AssistantEventRecord,
  callID: string,
  update: (tool: SessionMessage.AssistantTool) => SessionMessage.AssistantTool,
) {
  return {
    ...assistant,
    content: assistant.content.map((part) => (part.type === "tool" && part.id === callID ? update(part) : part)),
  }
}

function textParts(parts: V1Part[]) {
  const result: string[] = []
  for (const part of parts) {
    if (part.type === "text" && typeof part.text === "string") result.push(part.text)
  }
  return result
}

function reasoningParts(parts: V1Part[]) {
  return parts.filter((part) => part.type === "reasoning" && typeof part.text === "string")
}

function objectInput(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>
  if (typeof value === "string") {
    const parsed = parseValue(value)
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>
  }
  return {}
}

function textOutput(value: unknown) {
  if (typeof value === "string") return value
  if (value === undefined) return undefined
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function toolParts(parts: V1Part[], created: DateTime.Utc) {
  const result: SessionMessage.AssistantTool[] = []
  for (const part of parts) {
    if (part.type === "tool-invocation" && part.toolInvocation?.state === "result") {
      const invocation = part.toolInvocation
      if (typeof invocation.toolCallId !== "string" || typeof invocation.toolName !== "string") continue
      const output = textOutput(invocation.result)
      result.push(
        new SessionMessage.AssistantTool({
          type: "tool",
          id: invocation.toolCallId,
          name: invocation.toolName,
          provider: { executed: true },
          state: new SessionMessage.ToolStateCompleted({
            status: "completed",
            input: objectInput(invocation.args),
            content: output === undefined ? [] : [{ type: "text", text: output }],
            structured: {},
            result: invocation.result,
          }),
          time: { created, completed: created },
        }),
      )
    }
    if (part.type === "tool-invocation" && part.toolInvocation?.state === "partial-call") {
      const invocation = part.toolInvocation
      if (typeof invocation.toolCallId !== "string" || typeof invocation.toolName !== "string") continue
      result.push(
        new SessionMessage.AssistantTool({
          type: "tool",
          id: invocation.toolCallId,
          name: invocation.toolName,
          provider: { executed: false },
          state: new SessionMessage.ToolStatePending({
            status: "pending",
            input: textOutput(invocation.args) ?? "",
          }),
          time: { created },
        }),
      )
    }
    if (part.type === "tool-invocation" && part.toolInvocation?.state === "call") {
      const invocation = part.toolInvocation
      if (typeof invocation.toolCallId !== "string" || typeof invocation.toolName !== "string") continue
      result.push(
        new SessionMessage.AssistantTool({
          type: "tool",
          id: invocation.toolCallId,
          name: invocation.toolName,
          provider: { executed: false },
          state: new SessionMessage.ToolStateRunning({
            status: "running",
            input: objectInput(invocation.args),
            structured: {},
            content: [],
          }),
          time: { created },
        }),
      )
    }
    if (part.type === "tool" && part.state?.status === "pending") {
      result.push(
        new SessionMessage.AssistantTool({
          type: "tool",
          id: part.callID ?? part.id,
          name: part.tool ?? part.name ?? "tool",
          provider: { executed: false },
          state: new SessionMessage.ToolStatePending({
            status: "pending",
            input: part.state.raw ?? textOutput(part.state.input) ?? "",
          }),
          time: { created },
        }),
      )
    }
    if (part.type === "tool" && part.state?.status === "running") {
      result.push(
        new SessionMessage.AssistantTool({
          type: "tool",
          id: part.callID ?? part.id,
          name: part.tool ?? part.name ?? "tool",
          provider: { executed: false },
          state: new SessionMessage.ToolStateRunning({
            status: "running",
            input: objectInput(part.state.input),
            structured: part.state.metadata ?? {},
            content: [],
          }),
          time: {
            created:
              typeof part.state.time?.start === "number" ? DateTime.makeUnsafe(part.state.time.start) : created,
          },
        }),
      )
    }
    if (part.type === "tool" && part.state?.status === "completed") {
      const output = textOutput(part.state.output)
      result.push(
        new SessionMessage.AssistantTool({
          type: "tool",
          id: part.id,
          name: part.name ?? "tool",
          provider: { executed: false },
          state: new SessionMessage.ToolStateCompleted({
            status: "completed",
            input: objectInput(part.state.input),
            content: output === undefined ? [] : [{ type: "text", text: output }],
            structured: part.state.metadata ?? {},
            result: part.state.output,
          }),
          time: {
            created:
              typeof part.state.time?.start === "number" ? DateTime.makeUnsafe(part.state.time.start) : created,
            completed:
              typeof part.state.time?.end === "number" ? DateTime.makeUnsafe(part.state.time.end) : created,
          },
        }),
      )
    }
  }
  return result
}

function assetURL(value: string) {
  return !path.isAbsolute(value) && value.split(/[\\/]/)[0] === "assets"
}

function decodeDataURL(url: string) {
  const match = url.match(/^data:([^;,]+)?(;base64)?,([\s\S]*)$/)
  if (!match) return
  const mime = match[1] || "application/octet-stream"
  const payload = match[3] ?? ""
  try {
    const buffer = match[2] ? Buffer.from(payload, "base64") : Buffer.from(decodeURIComponent(payload))
    return { mime, buffer }
  } catch {
    return
  }
}

function extensionFor(mime: string, name: string | undefined) {
  const parsed = name ? path.extname(name) : ""
  if (parsed) return parsed
  switch (mime) {
    case "image/png":
      return ".png"
    case "image/jpeg":
      return ".jpg"
    case "image/gif":
      return ".gif"
    case "image/webp":
      return ".webp"
    case "application/pdf":
      return ".pdf"
    case "text/plain":
      return ".txt"
    default:
      return ".bin"
  }
}

function safeAssetStem(value: string | undefined) {
  return (value ?? "asset").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "asset"
}

async function materializePromptFile(info: SessionSchema.Info, file: FileAttachment, index: number) {
  if (!file.uri.startsWith("data:")) return { uri: file.uri, mime: file.mime }
  const decoded = decodeDataURL(file.uri)
  if (!decoded) return { uri: file.uri, mime: file.mime }
  const mime = file.mime || decoded.mime
  const sha256 = createHash("sha256").update(decoded.buffer).digest("hex")
  const root = sessionRoot(info)
  const relative = path.join(
    "assets",
    `${safeAssetStem(file.name ?? `file-${index}`)}-${sha256.slice(0, 16)}${extensionFor(mime, file.name)}`,
  )
  const target = path.join(root, relative)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await writeBufferIfMissing(target, decoded.buffer)
  return { uri: relative.split(path.sep).join("/"), mime }
}

async function resolvePromptFile(info: SessionSchema.Info, file: FileAttachment) {
  let uri = file.uri
  if (assetURL(uri)) {
    const root = sessionRoot(info)
    const assetsRoot = path.resolve(root, "assets")
    const assetPath = path.resolve(root, uri)
    if (assetPath !== assetsRoot && assetPath.startsWith(`${assetsRoot}${path.sep}`)) {
      const buffer = await fs.readFile(assetPath).catch((error: unknown) => {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined
        throw error
      })
      if (buffer) uri = `data:${file.mime};base64,${buffer.toString("base64")}`
    }
  }
  return new FileAttachment({
    uri,
    mime: file.mime,
    name: file.name,
    description: file.description,
    source: file.source,
  })
}

async function resolveFilePart(info: SessionSchema.Info, part: V1Part) {
  if (part.type !== "file" || typeof part.url !== "string" || typeof part.mime !== "string") return
  let uri = part.url
  if (assetURL(uri)) {
    const root = sessionRoot(info)
    const assetsRoot = path.resolve(root, "assets")
    const assetPath = path.resolve(root, uri)
    if (assetPath === assetsRoot || !assetPath.startsWith(`${assetsRoot}${path.sep}`)) return
    const buffer = await fs.readFile(assetPath).catch((error: unknown) => {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined
      throw error
    })
    if (!buffer) return
    uri = `data:${part.mime};base64,${buffer.toString("base64")}`
  }
  return new FileAttachment({
    uri,
    mime: part.mime,
    name: part.filename ?? part.name,
    description: part.description,
  })
}

function appendPartDelta(part: V1Part, field: string, delta: string) {
  const record = part as unknown as Record<string, unknown>
  const current = record[field]
  record[field] = typeof current === "string" ? current + delta : delta
}

async function toV2Message(
  info: SessionSchema.Info,
  message: V1Message,
  parts: V1Part[],
): Promise<SessionMessage.Message | undefined> {
  const id = SessionMessage.ID.make(message.id)
  const created = DateTime.makeUnsafe(messageCreated(message, 0))
  if (message.role === "user") {
    const files = (await Promise.all(parts.map((part) => resolveFilePart(info, part)))).filter(
      (file): file is FileAttachment => file !== undefined,
    )
    return new SessionMessage.User({
      id,
      type: "user",
      text: textParts(parts).join("\n"),
      files: files.length > 0 ? files : undefined,
      time: { created },
    })
  }
  if (message.role === "assistant") {
    const content: SessionMessage.AssistantContent[] = []
    for (const [index, text] of textParts(parts).entries()) {
      content.push(
        new SessionMessage.AssistantText({
          type: "text",
          id: `${id}-text-${index}`,
          text,
        }),
      )
    }
    for (const part of reasoningParts(parts)) {
      content.push(
        new SessionMessage.AssistantReasoning({
          type: "reasoning",
          id: part.id,
          text: part.text ?? "",
          providerMetadata: part.providerMetadata ?? part.metadata,
        }),
      )
    }
    content.push(...toolParts(parts, created))
    return new SessionMessage.Assistant({
      id,
      type: "assistant",
      agent: message.agent ?? "build",
      model: {
        providerID: ProviderV2.ID.make(message.model?.providerID ?? "unknown"),
        id: ModelV2.ID.make(message.model?.modelID ?? message.model?.id ?? "unknown"),
        variant: ModelV2.VariantID.make(message.model?.variant ?? "default"),
      },
      content,
      time: {
        created,
        completed:
          typeof message.time?.completed === "number" ? DateTime.makeUnsafe(message.time.completed) : undefined,
      },
    })
  }
}

export async function readSessionJsonlMessages(info: SessionSchema.Info) {
  const target = sessionJsonl(info)
  const raw = await fs.readFile(target, "utf8").catch((error: unknown) => {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return ""
    throw error
  })
  const messages = new Map<string, { info: V1Message; parts: V1Part[] }>()
  const orphanParts = new Map<string, V1Part[]>()
  const shells = new Map<string, ShellRecord>()
  const compactions = new Map<string, CompactionRecord>()
  const directMessages = new Map<string, DirectMessageRecord>()
  const promptEvents = new Map<string, PromptEventRecord>()
  const assistantEvents = new Map<string, AssistantEventRecord>()
  const removed = new Set<string>()
  const removedParts = new Set<string>()
  let index = 0
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    index++
    let entry: Record<string, unknown>
    try {
      entry = JSON.parse(trimmed) as Record<string, unknown>
    } catch {
      continue
    }
    const type = baseEventType(entry.type)
    const data = eventData(entry)
    if (type === "message.updated" && data.message && typeof data.message === "object") {
      const message = data.message as V1Message
      if (typeof message.id !== "string" || (message.role !== "user" && message.role !== "assistant")) continue
      const existing = messages.get(message.id)
      messages.set(message.id, { info: message, parts: existing?.parts ?? orphanParts.get(message.id) ?? [] })
      orphanParts.delete(message.id)
      removed.delete(message.id)
    }
    if (type === "message.part.updated" && data.part && typeof data.part === "object") {
      const part = data.part as V1Part
      if (typeof part.id !== "string" || typeof part.messageID !== "string") continue
      const message = messages.get(part.messageID)
      if (message) {
        const next = message.parts.filter((item) => item.id !== part.id)
        next.push(part)
        messages.set(part.messageID, { info: message.info, parts: next })
      } else {
        const next = (orphanParts.get(part.messageID) ?? []).filter((item) => item.id !== part.id)
        next.push(part)
        orphanParts.set(part.messageID, next)
      }
      removedParts.delete(`${part.messageID}:${part.id}`)
    }
    if (type === "message.part.delta") {
      const messageID = typeof data.messageID === "string" ? data.messageID : undefined
      const partID = typeof data.partID === "string" ? data.partID : undefined
      const field = typeof data.field === "string" ? data.field : undefined
      const delta = typeof data.delta === "string" ? data.delta : undefined
      if (!messageID || !partID || !field || delta === undefined) continue
      if (removedParts.has(`${messageID}:${partID}`)) continue
      const part =
        messages.get(messageID)?.parts.find((item) => item.id === partID) ??
        orphanParts.get(messageID)?.find((item) => item.id === partID)
      if (part) appendPartDelta(part, field, delta)
    }
    if (type === "message.removed" && typeof data.messageID === "string") {
      removed.add(data.messageID)
      messages.delete(data.messageID)
      orphanParts.delete(data.messageID)
    }
    if (type === "message.part.removed") {
      const messageID = typeof data.messageID === "string" ? data.messageID : undefined
      const partID = typeof data.partID === "string" ? data.partID : undefined
      if (!messageID || !partID) continue
      removedParts.add(`${messageID}:${partID}`)
      const message = messages.get(messageID)
      if (message) message.parts = message.parts.filter((part) => part.id !== partID)
      const orphan = orphanParts.get(messageID)
      if (orphan) orphanParts.set(messageID, orphan.filter((part) => part.id !== partID))
    }
    if (
      type === "session.next.prompted" ||
      type === "session.next.prompt.admitted" ||
      type === "session.next.prompt.promoted"
    ) {
      const data = eventData(entry)
      const messageID = typeof data.messageID === "string" ? data.messageID : undefined
      const prompt = data.prompt && typeof data.prompt === "object" ? (data.prompt as Record<string, unknown>) : undefined
      if (!messageID || !prompt) continue
      const text = typeof prompt.text === "string" ? prompt.text : undefined
      if (text === undefined) continue
      const files = Array.isArray(prompt.files)
        ? prompt.files.flatMap((file) => {
            if (!file || typeof file !== "object") return []
            const item = file as { uri?: unknown; mime?: unknown; name?: unknown; description?: unknown; source?: unknown }
            if (typeof item.uri !== "string" || typeof item.mime !== "string") return []
            return [
              new FileAttachment({
                uri: item.uri,
                mime: item.mime,
                name: typeof item.name === "string" ? item.name : undefined,
                description: typeof item.description === "string" ? item.description : undefined,
                source: item.source && typeof item.source === "object" ? (item.source as FileAttachment["source"]) : undefined,
              }),
            ]
          })
        : undefined
      const agents = Array.isArray(prompt.agents)
        ? prompt.agents.flatMap((agent) => {
            if (!agent || typeof agent !== "object") return []
            const item = agent as { name?: unknown; source?: unknown }
            if (typeof item.name !== "string") return []
            return [
              new AgentAttachment({
                name: item.name,
                source: item.source && typeof item.source === "object" ? (item.source as AgentAttachment["source"]) : undefined,
              }),
            ]
          })
        : undefined
      promptEvents.set(messageID, {
        messageID,
        text,
        files: files && files.length > 0 ? files : undefined,
        agents: agents && agents.length > 0 ? agents : undefined,
        created: timestampValue(data.timeCreated, timestampValue(data.timestamp, index)),
      })
      removed.delete(messageID)
    }
    if (type === "session.next.agent.switched") {
      const data = eventData(entry)
      const messageID = typeof data.messageID === "string" ? data.messageID : undefined
      const agent = typeof data.agent === "string" ? data.agent : undefined
      if (!messageID || !agent) continue
      directMessages.set(messageID, {
        kind: "agent",
        messageID,
        agent,
        created: timestampValue(data.timestamp, index),
      })
    }
    if (type === "session.next.model.switched") {
      const data = eventData(entry)
      const messageID = typeof data.messageID === "string" ? data.messageID : undefined
      const model = modelRef(data.model)
      if (!messageID || !model) continue
      directMessages.set(messageID, {
        kind: "model",
        messageID,
        model,
        created: timestampValue(data.timestamp, index),
      })
    }
    if (type === "session.next.context.updated") {
      const data = eventData(entry)
      const messageID = typeof data.messageID === "string" ? data.messageID : undefined
      const text = typeof data.text === "string" ? data.text : undefined
      if (!messageID || text === undefined) continue
      directMessages.set(messageID, {
        kind: "system",
        messageID,
        text,
        created: timestampValue(data.timestamp, index),
      })
    }
    if (type === "session.next.synthetic") {
      const data = eventData(entry)
      const messageID = typeof data.messageID === "string" ? data.messageID : undefined
      const text = typeof data.text === "string" ? data.text : undefined
      if (!messageID || text === undefined) continue
      directMessages.set(messageID, {
        kind: "synthetic",
        messageID,
        text,
        created: timestampValue(data.timestamp, index),
      })
    }
    if (type === "session.next.step.started") {
      const data = eventData(entry)
      const assistantMessageID =
        typeof data.assistantMessageID === "string" ? data.assistantMessageID : undefined
      const agent = typeof data.agent === "string" ? data.agent : undefined
      const model = modelRef(data.model)
      if (!assistantMessageID || !agent || !model) continue
      assistantEvents.set(assistantMessageID, {
        id: assistantMessageID,
        agent,
        model,
        content: assistantEvents.get(assistantMessageID)?.content ?? [],
        created: timestampValue(data.timestamp, index),
        snapshot: typeof data.snapshot === "string" ? { start: data.snapshot } : undefined,
      })
    }
    if (type === "session.next.step.ended") {
      const data = eventData(entry)
      const assistantMessageID =
        typeof data.assistantMessageID === "string" ? data.assistantMessageID : undefined
      if (!assistantMessageID) continue
      const assistant = assistantEvents.get(assistantMessageID)
      if (!assistant) continue
      const snapshot =
        typeof data.snapshot === "string" ? { ...assistant.snapshot, end: data.snapshot } : assistant.snapshot
      assistantEvents.set(assistantMessageID, {
        ...assistant,
        completed: timestampValue(data.timestamp, index),
        finish: typeof data.finish === "string" ? data.finish : undefined,
        cost: typeof data.cost === "number" ? data.cost : undefined,
        tokens: tokensValue(data.tokens),
        snapshot,
      })
    }
    if (type === "session.next.step.failed") {
      const data = eventData(entry)
      const assistantMessageID =
        typeof data.assistantMessageID === "string" ? data.assistantMessageID : undefined
      if (!assistantMessageID) continue
      const assistant = assistantEvents.get(assistantMessageID)
      if (!assistant) continue
      assistantEvents.set(assistantMessageID, {
        ...assistant,
        completed: timestampValue(data.timestamp, index),
        finish: "error",
        error: unknownError(data.error),
      })
    }
    if (type === "session.next.text.started") {
      const data = eventData(entry)
      const assistantMessageID =
        typeof data.assistantMessageID === "string" ? data.assistantMessageID : undefined
      const textID = typeof data.textID === "string" ? data.textID : undefined
      if (!assistantMessageID || !textID) continue
      const assistant = assistantEvents.get(assistantMessageID)
      if (!assistant) continue
      const content = assistant.content.filter((part) => !(part.type === "text" && part.id === textID))
      content.push(new SessionMessage.AssistantText({ type: "text", id: textID, text: "" }))
      assistantEvents.set(assistantMessageID, { ...assistant, content })
    }
    if (type === "session.next.text.ended") {
      const data = eventData(entry)
      const assistantMessageID =
        typeof data.assistantMessageID === "string" ? data.assistantMessageID : undefined
      const textID = typeof data.textID === "string" ? data.textID : undefined
      const text = typeof data.text === "string" ? data.text : undefined
      if (!assistantMessageID || !textID || text === undefined) continue
      const assistant = assistantEvents.get(assistantMessageID)
      if (!assistant) continue
      const content = assistant.content.filter((part) => !(part.type === "text" && part.id === textID))
      content.push(new SessionMessage.AssistantText({ type: "text", id: textID, text }))
      assistantEvents.set(assistantMessageID, { ...assistant, content })
    }
    if (type === "session.next.reasoning.started") {
      const data = eventData(entry)
      const assistantMessageID =
        typeof data.assistantMessageID === "string" ? data.assistantMessageID : undefined
      const reasoningID = typeof data.reasoningID === "string" ? data.reasoningID : undefined
      if (!assistantMessageID || !reasoningID) continue
      const assistant = assistantEvents.get(assistantMessageID)
      if (!assistant) continue
      const content = assistant.content.filter((part) => !(part.type === "reasoning" && part.id === reasoningID))
      content.push(
        new SessionMessage.AssistantReasoning({
          type: "reasoning",
          id: reasoningID,
          text: "",
          providerMetadata:
            data.providerMetadata && typeof data.providerMetadata === "object"
              ? (data.providerMetadata as Record<string, Record<string, unknown>>)
              : undefined,
        }),
      )
      assistantEvents.set(assistantMessageID, { ...assistant, content })
    }
    if (type === "session.next.reasoning.ended") {
      const data = eventData(entry)
      const assistantMessageID =
        typeof data.assistantMessageID === "string" ? data.assistantMessageID : undefined
      const reasoningID = typeof data.reasoningID === "string" ? data.reasoningID : undefined
      const text = typeof data.text === "string" ? data.text : undefined
      if (!assistantMessageID || !reasoningID || text === undefined) continue
      const assistant = assistantEvents.get(assistantMessageID)
      if (!assistant) continue
      const content = assistant.content.filter((part) => !(part.type === "reasoning" && part.id === reasoningID))
      content.push(
        new SessionMessage.AssistantReasoning({
          type: "reasoning",
          id: reasoningID,
          text,
          providerMetadata:
            data.providerMetadata && typeof data.providerMetadata === "object"
              ? (data.providerMetadata as Record<string, Record<string, unknown>>)
              : undefined,
        }),
      )
      assistantEvents.set(assistantMessageID, { ...assistant, content })
    }
    if (type === "session.next.tool.input.started") {
      const data = eventData(entry)
      const assistantMessageID =
        typeof data.assistantMessageID === "string" ? data.assistantMessageID : undefined
      const callID = typeof data.callID === "string" ? data.callID : undefined
      const name = typeof data.name === "string" ? data.name : undefined
      if (!assistantMessageID || !callID || !name) continue
      const assistant = assistantEvents.get(assistantMessageID)
      if (!assistant) continue
      const content = assistant.content.filter((part) => !(part.type === "tool" && part.id === callID))
      content.push(
        new SessionMessage.AssistantTool({
          type: "tool",
          id: callID,
          name,
          time: { created: DateTime.makeUnsafe(timestampValue(data.timestamp, index)) },
          state: new SessionMessage.ToolStatePending({ status: "pending", input: "" }),
        }),
      )
      assistantEvents.set(assistantMessageID, { ...assistant, content })
    }
    if (type === "session.next.tool.input.ended") {
      const data = eventData(entry)
      const assistantMessageID =
        typeof data.assistantMessageID === "string" ? data.assistantMessageID : undefined
      const callID = typeof data.callID === "string" ? data.callID : undefined
      const text = typeof data.text === "string" ? data.text : undefined
      if (!assistantMessageID || !callID || text === undefined) continue
      const assistant = assistantEvents.get(assistantMessageID)
      if (!assistant) continue
      assistantEvents.set(
        assistantMessageID,
        updateAssistantEventTool(assistant, callID, (tool) =>
          tool.state.status === "pending"
            ? new SessionMessage.AssistantTool({
                ...tool,
                state: new SessionMessage.ToolStatePending({ status: "pending", input: text }),
              })
            : tool,
        ),
      )
    }
    if (type === "session.next.tool.called") {
      const data = eventData(entry)
      const assistantMessageID =
        typeof data.assistantMessageID === "string" ? data.assistantMessageID : undefined
      const callID = typeof data.callID === "string" ? data.callID : undefined
      const provider = eventProvider(data.provider)
      if (!assistantMessageID || !callID) continue
      const assistant = assistantEvents.get(assistantMessageID)
      if (!assistant) continue
      assistantEvents.set(
        assistantMessageID,
        updateAssistantEventTool(assistant, callID, (tool) =>
          new SessionMessage.AssistantTool({
            ...tool,
            provider,
            time: { ...tool.time, ran: DateTime.makeUnsafe(timestampValue(data.timestamp, index)) },
            state: new SessionMessage.ToolStateRunning({
              status: "running",
              input: objectInput(data.input),
              structured: {},
              content: [],
            }),
          }),
        ),
      )
    }
    if (type === "session.next.tool.progress") {
      const data = eventData(entry)
      const assistantMessageID =
        typeof data.assistantMessageID === "string" ? data.assistantMessageID : undefined
      const callID = typeof data.callID === "string" ? data.callID : undefined
      if (!assistantMessageID || !callID) continue
      const assistant = assistantEvents.get(assistantMessageID)
      if (!assistant) continue
      assistantEvents.set(
        assistantMessageID,
        updateAssistantEventTool(assistant, callID, (tool) =>
          tool.state.status === "running"
            ? new SessionMessage.AssistantTool({
                ...tool,
                state: new SessionMessage.ToolStateRunning({
                  status: "running",
                  input: tool.state.input,
                  structured: eventStructured(data.structured),
                  content: eventContent(data.content),
                }),
              })
            : tool,
        ),
      )
    }
    if (type === "session.next.tool.success") {
      const data = eventData(entry)
      const assistantMessageID =
        typeof data.assistantMessageID === "string" ? data.assistantMessageID : undefined
      const callID = typeof data.callID === "string" ? data.callID : undefined
      const provider = eventProvider(data.provider)
      if (!assistantMessageID || !callID) continue
      const assistant = assistantEvents.get(assistantMessageID)
      if (!assistant) continue
      assistantEvents.set(
        assistantMessageID,
        updateAssistantEventTool(assistant, callID, (tool) =>
          tool.state.status === "running"
            ? new SessionMessage.AssistantTool({
                ...tool,
                provider: {
                  executed: provider.executed || tool.provider?.executed === true,
                  metadata: tool.provider?.metadata,
                  resultMetadata: provider.metadata,
                },
                time: { ...tool.time, completed: DateTime.makeUnsafe(timestampValue(data.timestamp, index)) },
                state: new SessionMessage.ToolStateCompleted({
                  status: "completed",
                  input: tool.state.input,
                  structured: eventStructured(data.structured),
                  content: eventContent(data.content),
                  outputPaths: eventOutputPaths(data.outputPaths),
                  result: data.result,
                }),
              })
            : tool,
        ),
      )
    }
    if (type === "session.next.tool.failed") {
      const data = eventData(entry)
      const assistantMessageID =
        typeof data.assistantMessageID === "string" ? data.assistantMessageID : undefined
      const callID = typeof data.callID === "string" ? data.callID : undefined
      const provider = eventProvider(data.provider)
      const error = unknownError(data.error)
      if (!assistantMessageID || !callID || !error) continue
      const assistant = assistantEvents.get(assistantMessageID)
      if (!assistant) continue
      assistantEvents.set(
        assistantMessageID,
        updateAssistantEventTool(assistant, callID, (tool) =>
          tool.state.status === "pending" || tool.state.status === "running"
            ? new SessionMessage.AssistantTool({
                ...tool,
                provider: {
                  executed: provider.executed || tool.provider?.executed === true,
                  metadata: tool.provider?.metadata,
                  resultMetadata: provider.metadata,
                },
                time: { ...tool.time, completed: DateTime.makeUnsafe(timestampValue(data.timestamp, index)) },
                state: new SessionMessage.ToolStateError({
                  status: "error",
                  error,
                  input: tool.state.status === "running" ? tool.state.input : {},
                  structured: tool.state.status === "running" ? tool.state.structured : {},
                  content: tool.state.status === "running" ? tool.state.content : [],
                  result: data.result,
                }),
              })
            : tool,
        ),
      )
    }
    if (type === "session.next.shell.started") {
      const data = eventData(entry)
      const messageID = typeof data.messageID === "string" ? data.messageID : undefined
      const callID = typeof data.callID === "string" ? data.callID : undefined
      const command = typeof data.command === "string" ? data.command : undefined
      if (!messageID || !callID || command === undefined) continue
      shells.set(callID, {
        messageID,
        callID,
        command,
        output: "",
        created: timestampValue(data.timestamp, index),
      })
    }
    if (type === "session.next.shell.ended") {
      const data = eventData(entry)
      const callID = typeof data.callID === "string" ? data.callID : undefined
      const output = typeof data.output === "string" ? data.output : undefined
      if (!callID || output === undefined) continue
      const shell = shells.get(callID)
      if (!shell) continue
      shells.set(callID, {
        ...shell,
        output,
        completed: timestampValue(data.timestamp, index),
      })
    }
    if (type === "session.next.compaction.started") {
      const data = eventData(entry)
      const messageID = typeof data.messageID === "string" ? data.messageID : undefined
      const reason = data.reason === "auto" || data.reason === "manual" ? data.reason : undefined
      if (!messageID || !reason) continue
      compactions.set(messageID, {
        messageID,
        reason,
        summary: "",
        recent: "",
        created: timestampValue(data.timestamp, index),
      })
    }
    if (type === "session.next.compaction.ended") {
      const data = eventData(entry)
      const messageID = typeof data.messageID === "string" ? data.messageID : undefined
      const summary = typeof data.text === "string" ? data.text : undefined
      const recent = typeof data.recent === "string" ? data.recent : ""
      const reason = data.reason === "auto" || data.reason === "manual" ? data.reason : "manual"
      if (!messageID || summary === undefined) continue
      const existing = compactions.get(messageID)
      compactions.set(messageID, {
        messageID,
        reason: existing?.reason ?? reason,
        summary,
        recent,
        created: existing?.created ?? timestampValue(data.timestamp, index),
      })
    }
  }

  const replayed = [...messages.values()]
    .filter((message) => !removed.has(message.info.id))
    .map((message) => ({
      ...message,
      parts: message.parts.filter((part) => !removedParts.has(`${message.info.id}:${part.id}`)),
    }))
    .sort((a, b) => messageCreated(a.info, index) - messageCreated(b.info, index) || a.info.id.localeCompare(b.info.id))

  const converted: SessionMessage.Message[] = []
  const replayedMessageIDs = new Set<string>()
  for (const message of replayed) {
    const item = await toV2Message(info, message.info, message.parts)
    if (item) {
      converted.push(item)
      replayedMessageIDs.add(item.id)
    }
  }
  for (const prompt of promptEvents.values()) {
    if (removed.has(prompt.messageID) || replayedMessageIDs.has(prompt.messageID)) continue
    const files = prompt.files
      ? (await Promise.all(prompt.files.map((file) => resolvePromptFile(info, file)))).filter(
          (file): file is FileAttachment => file !== undefined,
        )
      : undefined
    converted.push(
      new SessionMessage.User({
        id: SessionMessage.ID.make(prompt.messageID),
        type: "user",
        text: prompt.text,
        files: files && files.length > 0 ? files : undefined,
        agents: prompt.agents,
        time: { created: DateTime.makeUnsafe(prompt.created) },
      }),
    )
  }
  for (const message of directMessages.values()) {
    const created = DateTime.makeUnsafe(message.created)
    if (message.kind === "agent") {
      converted.push(
        new SessionMessage.AgentSwitched({
          id: SessionMessage.ID.make(message.messageID),
          type: "agent-switched",
          agent: AgentV2.ID.make(message.agent),
          time: { created },
        }),
      )
    }
    if (message.kind === "model") {
      converted.push(
        new SessionMessage.ModelSwitched({
          id: SessionMessage.ID.make(message.messageID),
          type: "model-switched",
          model: message.model,
          time: { created },
        }),
      )
    }
    if (message.kind === "system") {
      converted.push(
        new SessionMessage.System({
          id: SessionMessage.ID.make(message.messageID),
          type: "system",
          text: message.text,
          time: { created },
        }),
      )
    }
    if (message.kind === "synthetic") {
      converted.push(
        new SessionMessage.Synthetic({
          id: SessionMessage.ID.make(message.messageID),
          sessionID: info.id,
          type: "synthetic",
          text: message.text,
          time: { created },
        }),
      )
    }
  }
  for (const assistant of assistantEvents.values()) {
    if (removed.has(assistant.id) || replayedMessageIDs.has(assistant.id)) continue
    converted.push(
      new SessionMessage.Assistant({
        id: SessionMessage.ID.make(assistant.id),
        type: "assistant",
        agent: assistant.agent,
        model: assistant.model,
        content: assistant.content,
        snapshot: assistant.snapshot,
        finish: assistant.finish,
        cost: assistant.cost,
        tokens: assistant.tokens,
        error: assistant.error,
        time: {
          created: DateTime.makeUnsafe(assistant.created),
          completed: assistant.completed === undefined ? undefined : DateTime.makeUnsafe(assistant.completed),
        },
      }),
    )
  }
  for (const shell of shells.values()) {
    converted.push(
      new SessionMessage.Shell({
        id: SessionMessage.ID.make(shell.messageID),
        type: "shell",
        callID: shell.callID,
        command: shell.command,
        output: shell.output,
        time: {
          created: DateTime.makeUnsafe(shell.created),
          completed: shell.completed === undefined ? undefined : DateTime.makeUnsafe(shell.completed),
        },
      }),
    )
  }
  for (const compaction of compactions.values()) {
    converted.push(
      new SessionMessage.Compaction({
        id: SessionMessage.ID.make(compaction.messageID),
        type: "compaction",
        reason: compaction.reason,
        summary: compaction.summary,
        recent: compaction.recent,
        time: { created: DateTime.makeUnsafe(compaction.created) },
      }),
    )
  }
  return converted.sort((a, b) => {
    const left = DateTime.toEpochMillis(a.time.created)
    const right = DateTime.toEpochMillis(b.time.created)
    return left - right || a.id.localeCompare(b.id)
  })
}

export async function appendPromptJsonl(info: SessionSchema.Info, admitted: SessionInput.Admitted) {
  const created = DateTime.toEpochMillis(admitted.timeCreated)
  const files: FileAttachment[] = []
  for (const [index, file] of (admitted.prompt.files ?? []).entries()) {
    const materialized = await materializePromptFile(info, file, index)
    files.push(new FileAttachment({ ...file, uri: materialized.uri, mime: materialized.mime }))
  }
  const entries: Record<string, unknown>[] = [
    {
      type: "session.next.prompt.admitted",
      sessionID: admitted.sessionID,
      messageID: admitted.id,
      timestamp: created,
      prompt: new Prompt({
        text: admitted.prompt.text,
        files: files.length > 0 ? files : undefined,
        agents: admitted.prompt.agents,
      }),
      delivery: admitted.delivery,
    },
    {
      type: "message.updated",
      message: {
        id: admitted.id,
        sessionID: admitted.sessionID,
        role: "user",
        time: { created },
      },
    },
  ]
  entries.push(
    {
      type: "message.part.updated",
      part: {
        id: promptPartID(admitted.id),
        sessionID: admitted.sessionID,
        messageID: admitted.id,
        type: "text",
        text: admitted.prompt.text,
      },
    },
  )
  for (const [index, file] of files.entries()) {
    entries.push({
      type: "message.part.updated",
      part: {
        id: `${promptPartID(admitted.id)}_file_${index}`,
        sessionID: admitted.sessionID,
        messageID: admitted.id,
        type: "file",
        mime: file.mime,
        filename: file.name,
        url: file.uri,
        description: file.description,
      },
    })
  }
  await appendJsonl(sessionJsonl(info), entries)
}

export async function readSessionJsonlEntries(info: SessionSchema.Info) {
  const raw = await fs.readFile(sessionJsonl(info), "utf8").catch((error: unknown) => {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return ""
    throw error
  })
  const entries: Array<{ index: number; entry: Record<string, unknown> }> = []
  let index = 0
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    index++
    try {
      const entry = JSON.parse(trimmed) as unknown
      if (isRecord(entry)) entries.push({ index, entry })
    } catch {
      continue
    }
  }
  return entries
}
