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
import { FileAttachment } from "../session/prompt"
import { SessionSchema } from "../session/schema"
import { WorkspaceV2 } from "../workspace"

const FindMaxDepth = 8
const FindMaxNodes = 2_000
const IgnoredDirectories = new Set([
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
  const model =
    data.model && typeof data.model === "object"
      ? (data.model as { id?: unknown; providerID?: unknown; variant?: unknown })
      : undefined

  return SessionSchema.Info.make({
    id: SessionSchema.ID.make(data.id),
    parentID: typeof data.parentID === "string" ? SessionSchema.ID.make(data.parentID) : undefined,
    projectID: ProjectV2.ID.make(typeof data.projectID === "string" ? data.projectID : "global"),
    title: typeof data.title === "string" ? data.title : data.id,
    agent: typeof data.agent === "string" ? AgentV2.ID.make(data.agent) : undefined,
    model:
      typeof model?.id === "string" && typeof model.providerID === "string"
        ? {
            id: ModelV2.ID.make(model.id),
            providerID: ProviderV2.ID.make(model.providerID),
            variant: ModelV2.VariantID.make(typeof model.variant === "string" ? model.variant : "default"),
          }
        : undefined,
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

export async function readSessionStore(directory: string, sessionID: SessionSchema.ID) {
  const target = path.join(directory, ".agents", "atree", "sessions", sessionID, "meta.yaml")
  const raw = await fs.readFile(target, "utf8").catch((error: unknown) => {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined
    throw error
  })
  if (!raw) return
  return parseMeta(raw, directory)
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
  return sessions
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
  text?: string
  url?: string
  mime?: string
  filename?: string
  name?: string
  description?: string
}

function sessionRoot(info: SessionSchema.Info) {
  return path.join(info.location.directory, ".agents", "atree", "sessions", info.id)
}

function sessionJsonl(info: SessionSchema.Info) {
  return path.join(sessionRoot(info), "session.jsonl")
}

function promptPartID(messageID: SessionMessage.ID) {
  return `prt_${messageID.replace(/^msg_?/, "")}_text`
}

async function appendJsonl(target: string, entries: Record<string, unknown>[]) {
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.appendFile(target, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n")
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

function textParts(parts: V1Part[]) {
  const result: string[] = []
  for (const part of parts) {
    if (part.type === "text" && typeof part.text === "string") result.push(part.text)
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
    return new SessionMessage.Assistant({
      id,
      type: "assistant",
      agent: message.agent ?? "build",
      model: {
        providerID: ProviderV2.ID.make(message.model?.providerID ?? "unknown"),
        id: ModelV2.ID.make(message.model?.modelID ?? message.model?.id ?? "unknown"),
        variant: ModelV2.VariantID.make(message.model?.variant ?? "default"),
      },
      content: textParts(parts).map(
        (text, index) =>
          new SessionMessage.AssistantText({
            type: "text",
            id: `${id}-text-${index}`,
            text,
          }),
      ),
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
    if (entry.type === "message.updated" && entry.message && typeof entry.message === "object") {
      const message = entry.message as V1Message
      if (typeof message.id !== "string" || (message.role !== "user" && message.role !== "assistant")) continue
      const existing = messages.get(message.id)
      messages.set(message.id, { info: message, parts: existing?.parts ?? [] })
      removed.delete(message.id)
    }
    if (entry.type === "message.part.updated" && entry.part && typeof entry.part === "object") {
      const part = entry.part as V1Part
      if (typeof part.id !== "string" || typeof part.messageID !== "string") continue
      const message = messages.get(part.messageID)
      if (!message) continue
      const next = message.parts.filter((item) => item.id !== part.id)
      next.push(part)
      messages.set(part.messageID, { info: message.info, parts: next })
      removedParts.delete(`${part.messageID}:${part.id}`)
    }
    if (entry.type === "message.part.delta") {
      const messageID = typeof entry.messageID === "string" ? entry.messageID : undefined
      const partID = typeof entry.partID === "string" ? entry.partID : undefined
      const field = typeof entry.field === "string" ? entry.field : undefined
      const delta = typeof entry.delta === "string" ? entry.delta : undefined
      if (!messageID || !partID || !field || delta === undefined) continue
      if (removedParts.has(`${messageID}:${partID}`)) continue
      const part = messages.get(messageID)?.parts.find((item) => item.id === partID)
      if (part) appendPartDelta(part, field, delta)
    }
    if (entry.type === "message.removed" && typeof entry.messageID === "string") {
      removed.add(entry.messageID)
      messages.delete(entry.messageID)
    }
    if (entry.type === "message.part.removed") {
      const messageID = typeof entry.messageID === "string" ? entry.messageID : undefined
      const partID = typeof entry.partID === "string" ? entry.partID : undefined
      if (!messageID || !partID) continue
      removedParts.add(`${messageID}:${partID}`)
      const message = messages.get(messageID)
      if (message) message.parts = message.parts.filter((part) => part.id !== partID)
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
  for (const message of replayed) {
    const item = await toV2Message(info, message.info, message.parts)
    if (item) converted.push(item)
  }
  return converted
}

export async function appendPromptJsonl(info: SessionSchema.Info, admitted: SessionInput.Admitted) {
  const created = DateTime.toEpochMillis(admitted.timeCreated)
  const entries: Record<string, unknown>[] = [
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
  for (const [index, file] of (admitted.prompt.files ?? []).entries()) {
    const materialized = await materializePromptFile(info, file, index)
    entries.push({
      type: "message.part.updated",
      part: {
        id: `${promptPartID(admitted.id)}_file_${index}`,
        sessionID: admitted.sessionID,
        messageID: admitted.id,
        type: "file",
        mime: materialized.mime,
        filename: file.name,
        url: materialized.uri,
        description: file.description,
      },
    })
  }
  await appendJsonl(sessionJsonl(info), entries)
}
