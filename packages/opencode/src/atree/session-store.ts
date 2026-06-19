import fs from "fs/promises"
import path from "path"
import { createHash } from "crypto"
import { ensureAtreeDirectoryStore } from "./directory-store"
import type { SessionID } from "@/session/schema"
import type { Session } from "@/session/session"
import type { SessionV1 } from "@opencode-ai/core/v1/session"

type SessionInfo = Session.Info & {
  id: SessionID
}

function yamlString(value: string | undefined) {
  return JSON.stringify(value ?? null)
}

function yamlValue(value: unknown) {
  return JSON.stringify(value ?? null)
}

function yamlMetadata(metadata: SessionInfo["metadata"]) {
  if (!metadata || Object.keys(metadata).length === 0) return "metadata: {}\n"
  return `metadata: ${JSON.stringify(metadata)}\n`
}

function metaYaml(info: SessionInfo) {
  return [
    "version: 1",
    `id: ${yamlString(info.id)}`,
    `slug: ${yamlString(info.slug)}`,
    `sessionVersion: ${yamlString(info.version)}`,
    `directory: ${yamlString(info.directory)}`,
    `path: ${yamlString(info.path)}`,
    `projectID: ${yamlString(info.projectID)}`,
    `workspaceID: ${yamlString(info.workspaceID)}`,
    `parentID: ${yamlString(info.parentID)}`,
    `title: ${yamlString(info.title)}`,
    `agent: ${yamlString(info.agent)}`,
    `model: ${yamlValue(info.model)}`,
    `createdAt: ${info.time.created}`,
    `updatedAt: ${info.time.updated}`,
    `archivedAt: ${yamlValue(info.time.archived)}`,
    `cost: ${yamlValue(info.cost)}`,
    `tokens: ${yamlValue(info.tokens)}`,
    `permission: ${yamlValue(info.permission)}`,
    `share: ${yamlValue(info.share)}`,
    `summary: ${yamlValue(info.summary)}`,
    `revert: ${yamlValue(info.revert)}`,
    `source: ${yamlValue("opencode")}`,
    yamlMetadata(info.metadata).trimEnd(),
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
  try {
    await fs.writeFile(target, content, { flag: "wx" })
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") return
    throw error
  }
}

async function writeBufferIfMissing(target: string, content: Buffer) {
  try {
    await fs.writeFile(target, content, { flag: "wx" })
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") return
    throw error
  }
}

function sessionRoot(info: SessionInfo) {
  return path.join(info.directory, ".agents", "atree", "sessions", info.id)
}

export async function writeSessionStore(info: SessionInfo) {
  await ensureAtreeDirectoryStore(info.directory)
  const root = sessionRoot(info)
  await fs.mkdir(path.join(root, "assets"), { recursive: true })
  await writeIfMissing(path.join(root, "session.jsonl"), "")
  await writeAtomic(path.join(root, "meta.yaml"), metaYaml(info))
}

export async function deleteSessionStore(info: SessionInfo) {
  await fs.rm(sessionRoot(info), { recursive: true, force: true })
}

export async function ensureSessionStore(info: SessionInfo) {
  await writeSessionStore(info)
}

export async function ensureSessionPayloadFiles(info: SessionInfo) {
  await ensureAtreeDirectoryStore(info.directory)
  const root = sessionRoot(info)
  await fs.mkdir(path.join(root, "assets"), { recursive: true })
  await writeIfMissing(path.join(root, "session.jsonl"), "")
}

type SessionAsset = {
  partID?: string
  messageID?: string
  filename?: string
  mime: string
  path: string
  sha256: string
  size: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
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

function extensionFor(mime: string, filename: string | undefined) {
  const parsed = filename ? path.extname(filename) : ""
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

function collectFileRecords(value: unknown, output: Record<string, unknown>[] = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectFileRecords(item, output)
    return output
  }
  if (!isRecord(value)) return output
  if (value.type === "file" && typeof value.url === "string" && value.url.startsWith("data:")) output.push(value)
  for (const item of Object.values(value)) collectFileRecords(item, output)
  return output
}

async function materializeDataURLAssets(info: SessionInfo, entry: Record<string, unknown>) {
  const root = sessionRoot(info)
  const assetsRoot = path.join(root, "assets")
  const assets: SessionAsset[] = []
  for (const file of collectFileRecords(entry)) {
    const decoded = decodeDataURL(file.url as string)
    if (!decoded) continue
    const mime = typeof file.mime === "string" ? file.mime : decoded.mime
    const filename = typeof file.filename === "string" ? file.filename : undefined
    const partID = typeof file.id === "string" ? file.id : undefined
    const messageID = typeof file.messageID === "string" ? file.messageID : undefined
    const sha256 = createHash("sha256").update(decoded.buffer).digest("hex")
    const stem = safeAssetStem(partID ?? filename)
    const relative = path.join("assets", `${stem}-${sha256.slice(0, 16)}${extensionFor(mime, filename)}`)
    const target = path.join(root, relative)
    await fs.mkdir(assetsRoot, { recursive: true })
    await writeBufferIfMissing(target, decoded.buffer)
    assets.push({
      partID,
      messageID,
      filename,
      mime,
      path: relative.split(path.sep).join("/"),
      sha256,
      size: decoded.buffer.byteLength,
    })
  }
  return assets
}

export async function appendSessionJsonl(info: SessionInfo, entry: Record<string, unknown>) {
  await ensureSessionPayloadFiles(info)
  const assets = await materializeDataURLAssets(info, entry)
  const line = JSON.stringify({
    version: 1,
    at: Date.now(),
    ...entry,
    ...(assets.length > 0 ? { assets } : {}),
  })
  await fs.appendFile(path.join(sessionRoot(info), "session.jsonl"), `${line}\n`)
}

function upsertPart(parts: SessionV1.Part[], part: SessionV1.Part) {
  const index = parts.findIndex((item) => item.id === part.id)
  if (index === -1) {
    parts.push(part)
    parts.sort((a, b) => a.id.localeCompare(b.id))
    return
  }
  parts[index] = part
}

function appendPartDelta(part: SessionV1.Part, field: string, delta: string) {
  const record = part as unknown as Record<string, unknown>
  const current = record[field]
  record[field] = typeof current === "string" ? current + delta : delta
}

export async function readSessionJsonlProjection(info: SessionInfo) {
  const target = path.join(sessionRoot(info), "session.jsonl")
  const raw = await fs.readFile(target, "utf8").catch((error: unknown) => {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return ""
    throw error
  })
  let hasEvents = false
  const removedMessageIDs = new Set<string>()
  const removedPartIDs = new Set<string>()
  const messages = new Map<string, SessionV1.WithParts>()
  const orphanParts = new Map<string, SessionV1.Part[]>()

  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue
    let entry: Record<string, unknown>
    try {
      entry = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    hasEvents = true

    if (entry.type === "message.updated" && entry.message && typeof entry.message === "object") {
      const message = entry.message as SessionV1.Info
      const existing = messages.get(message.id)
      const parts = existing?.parts ?? orphanParts.get(message.id) ?? []
      messages.set(message.id, { info: message, parts })
      orphanParts.delete(message.id)
      continue
    }

    if (entry.type === "message.part.updated" && entry.part && typeof entry.part === "object") {
      const part = entry.part as SessionV1.Part
      const message = messages.get(part.messageID)
      if (message) {
        upsertPart(message.parts, part)
        continue
      }
      const parts = orphanParts.get(part.messageID) ?? []
      upsertPart(parts, part)
      orphanParts.set(part.messageID, parts)
      continue
    }

    if (entry.type === "message.part.delta") {
      const messageID = typeof entry.messageID === "string" ? entry.messageID : undefined
      const partID = typeof entry.partID === "string" ? entry.partID : undefined
      const field = typeof entry.field === "string" ? entry.field : undefined
      const delta = typeof entry.delta === "string" ? entry.delta : undefined
      if (!messageID || !partID || !field || delta === undefined) continue
      const part =
        messages.get(messageID)?.parts.find((item) => item.id === partID) ??
        orphanParts.get(messageID)?.find((item) => item.id === partID)
      if (part) appendPartDelta(part, field, delta)
      continue
    }

    if (entry.type === "message.removed") {
      const messageID = typeof entry.messageID === "string" ? entry.messageID : undefined
      if (!messageID) continue
      removedMessageIDs.add(messageID)
      messages.delete(messageID)
      orphanParts.delete(messageID)
      continue
    }

    if (entry.type === "message.part.removed") {
      const messageID = typeof entry.messageID === "string" ? entry.messageID : undefined
      const partID = typeof entry.partID === "string" ? entry.partID : undefined
      if (!messageID || !partID) continue
      removedPartIDs.add(`${messageID}:${partID}`)
      const message = messages.get(messageID)
      if (message) message.parts = message.parts.filter((part) => part.id !== partID)
      const parts = orphanParts.get(messageID)
      if (parts) orphanParts.set(messageID, parts.filter((part) => part.id !== partID))
    }
  }

  return {
    hasEvents,
    removedMessageIDs,
    removedPartIDs,
    messages: [...messages.values()].sort(
      (a, b) => a.info.time.created - b.info.time.created || a.info.id.localeCompare(b.info.id),
    ),
  }
}

export async function readSessionJsonlMessages(info: SessionInfo) {
  return (await readSessionJsonlProjection(info)).messages
}

export async function readSessionStore(directory: string, sessionID: SessionID) {
  const target = path.join(directory, ".agents", "atree", "sessions", sessionID, "meta.yaml")
  const raw = await fs.readFile(target, "utf8").catch((error: unknown) => {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined
    throw error
  })
  if (!raw) return
  return parseMeta(raw, directory)
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

function parseMeta(raw: string, fallbackDirectory: string): SessionInfo | undefined {
  const data: Record<string, unknown> = {}
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z][A-Za-z0-9]*):\s*(.*)$/)
    if (!match) continue
    data[match[1]] = parseValue(match[2] ?? "")
  }

  if (typeof data.id !== "string") return
  const directory = typeof data.directory === "string" ? data.directory : fallbackDirectory
  const created = typeof data.createdAt === "number" ? data.createdAt : 0
  const updated = typeof data.updatedAt === "number" ? data.updatedAt : created
  const archived = typeof data.archivedAt === "number" ? data.archivedAt : undefined
  const metadata =
    data.metadata && typeof data.metadata === "object" && Object.keys(data.metadata).length > 0
      ? (data.metadata as SessionInfo["metadata"])
      : undefined
  return {
    id: data.id as SessionID,
    slug: typeof data.slug === "string" ? data.slug : data.id,
    version: typeof data.sessionVersion === "string" ? data.sessionVersion : "atree",
    projectID: (typeof data.projectID === "string" ? data.projectID : "global") as SessionInfo["projectID"],
    directory,
    path: typeof data.path === "string" ? data.path : undefined,
    workspaceID:
      typeof data.workspaceID === "string" ? (data.workspaceID as SessionInfo["workspaceID"]) : undefined,
    parentID: typeof data.parentID === "string" ? (data.parentID as SessionID) : undefined,
    title: typeof data.title === "string" ? data.title : data.id,
    agent: typeof data.agent === "string" ? data.agent : undefined,
    model: data.model && typeof data.model === "object" ? (data.model as SessionInfo["model"]) : undefined,
    metadata,
    permission: Array.isArray(data.permission) ? (data.permission as SessionInfo["permission"]) : undefined,
    share: data.share && typeof data.share === "object" ? (data.share as SessionInfo["share"]) : undefined,
    summary: data.summary && typeof data.summary === "object" ? (data.summary as SessionInfo["summary"]) : undefined,
    revert: data.revert && typeof data.revert === "object" ? (data.revert as SessionInfo["revert"]) : undefined,
    cost: typeof data.cost === "number" ? data.cost : 0,
    tokens:
      data.tokens && typeof data.tokens === "object"
        ? (data.tokens as SessionInfo["tokens"])
        : { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: {
      created,
      updated,
      ...(archived !== undefined ? { archived } : {}),
    },
  }
}

export async function readSessionStores(directory: string) {
  const root = path.join(directory, ".agents", "atree", "sessions")
  const entries = await fs.readdir(root, { withFileTypes: true }).catch((error: unknown) => {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return []
    throw error
  })
  const sessions: SessionInfo[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const raw = await fs.readFile(path.join(root, entry.name, "meta.yaml"), "utf8").catch((error: unknown) => {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined
      throw error
    })
    if (!raw) continue
    const parsed = parseMeta(raw, directory)
    if (parsed) sessions.push(parsed)
  }
  sessions.sort((a, b) => b.time.updated - a.time.updated || b.id.localeCompare(a.id))
  return sessions
}
