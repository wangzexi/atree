import fs from "fs/promises"
import path from "path"
import { createHash, randomUUID } from "crypto"
import { ensureAtreeDirectoryStore } from "./directory-store"
import type { SessionID } from "@/session/schema"
import type { Session } from "@/session/session"
import type { SessionV1 } from "@opencode-ai/core/v1/session"

type SessionInfo = Session.Info & {
  id: SessionID
}
type SessionModel = NonNullable<SessionInfo["model"]>

function yamlString(value: string | undefined) {
  return JSON.stringify(value ?? null)
}

function yamlValue(value: unknown) {
  return JSON.stringify(value ?? null)
}

function baseEventType(value: unknown) {
  if (typeof value !== "string") return
  return value.replace(/\.\d+$/, "")
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
    `projectID: ${yamlString(info.projectID)}`,
    `workspaceID: ${yamlString(info.workspaceID)}`,
    `path: ${yamlString(info.path)}`,
    `parentID: ${yamlString(info.parentID)}`,
    `title: ${yamlString(info.title)}`,
    `agent: ${yamlString(info.agent)}`,
    `model: ${yamlValue(info.model)}`,
    `createdAt: ${info.time.created}`,
    `updatedAt: ${info.time.updated}`,
    `compactingAt: ${yamlValue(info.time.compacting)}`,
    `archivedAt: ${yamlValue(info.time.archived)}`,
    `cost: ${yamlValue(info.cost)}`,
    `tokens: ${yamlValue(info.tokens)}`,
    `permission: ${yamlValue(info.permission)}`,
    `share: ${yamlValue(info.share)}`,
    `summary: ${yamlValue(info.summary)}`,
    `revert: ${yamlValue(info.revert)}`,
    yamlMetadata(info.metadata).trimEnd(),
    "",
  ].join("\n")
}

async function writeAtomic(target: string, content: string) {
  await fs.mkdir(path.dirname(target), { recursive: true })
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`)
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

function sessionRootByID(directory: string, sessionID: string) {
  return path.join(directory, ".agents", "atree", "sessions", sessionID)
}

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

export async function ensureSessionPayloadFilesByID(directory: string, sessionID: string) {
  await ensureAtreeDirectoryStore(directory)
  const root = sessionRootByID(directory, sessionID)
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

type MaterializedAssets = {
  entry: Record<string, unknown>
  assets: SessionAsset[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
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

function modelRef(value: unknown): SessionInfo["model"] | undefined {
  if (!isRecord(value) || typeof value.providerID !== "string") return
  const id = typeof value.id === "string" ? value.id : typeof value.modelID === "string" ? value.modelID : undefined
  if (!id) return
  return {
    id: id as SessionModel["id"],
    providerID: value.providerID as SessionModel["providerID"],
    ...(typeof value.variant === "string" ? { variant: value.variant } : {}),
  }
}

function diffSummary(value: unknown): SessionInfo["summary"] | undefined {
  if (!Array.isArray(value)) return
  const diffs = value.filter((item): item is Record<string, unknown> => isRecord(item))
  if (diffs.length !== value.length) return
  const additions = diffs.reduce((sum, item) => sum + (typeof item.additions === "number" ? item.additions : 0), 0)
  const deletions = diffs.reduce((sum, item) => sum + (typeof item.deletions === "number" ? item.deletions : 0), 0)
  return {
    additions,
    deletions,
    files: diffs.length,
    diffs: value as NonNullable<SessionInfo["summary"]>["diffs"],
  }
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

function assetURL(value: string) {
  return !path.isAbsolute(value) && value.split(/[\\/]/)[0] === "assets"
}

async function materializeFileRecord(
  root: string,
  assetsRoot: string,
  file: Record<string, unknown>,
): Promise<{ file: Record<string, unknown>; asset?: SessionAsset }> {
  if (typeof file.url !== "string" || !file.url.startsWith("data:")) return { file }
  const decoded = decodeDataURL(file.url)
  if (!decoded) return { file }
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
  const asset = {
    partID,
    messageID,
    filename,
    mime,
    path: relative.split(path.sep).join("/"),
    sha256,
    size: decoded.buffer.byteLength,
  } satisfies SessionAsset
  return {
    file: {
      ...file,
      mime,
      url: asset.path,
    },
    asset,
  }
}

async function materializeValue(value: unknown, root: string, assetsRoot: string, assets: SessionAsset[]): Promise<unknown> {
  if (Array.isArray(value)) {
    return Promise.all(value.map((item) => materializeValue(item, root, assetsRoot, assets)))
  }
  if (!isRecord(value)) return value
  if (value.type === "file") {
    const materialized = await materializeFileRecord(root, assetsRoot, value)
    if (materialized.asset) assets.push(materialized.asset)
    return materialized.file
  }
  const next: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) {
    next[key] = await materializeValue(child, root, assetsRoot, assets)
  }
  return next
}

async function materializeDataURLAssets(info: SessionInfo, entry: Record<string, unknown>): Promise<MaterializedAssets> {
  const root = sessionRoot(info)
  const assetsRoot = path.join(root, "assets")
  const assets: SessionAsset[] = []
  const materialized = await materializeValue(entry, root, assetsRoot, assets)
  return { entry: materialized as Record<string, unknown>, assets }
}

export async function appendSessionJsonl(info: SessionInfo, entry: Record<string, unknown>) {
  await ensureSessionPayloadFiles(info)
  const materialized = await materializeDataURLAssets(info, entry)
  const line = JSON.stringify({
    version: 1,
    at: Date.now(),
    ...materialized.entry,
    ...(materialized.assets.length > 0 ? { assets: materialized.assets } : {}),
  })
  await fs.appendFile(path.join(sessionRoot(info), "session.jsonl"), `${line}\n`)
}

async function resolveAssetURL(info: SessionInfo, part: SessionV1.Part) {
  if (part.type !== "file") return part
  if (!assetURL(part.url)) return part
  const root = sessionRoot(info)
  const assetsRoot = path.resolve(root, "assets")
  const assetPath = path.resolve(root, part.url)
  if (assetPath !== assetsRoot && !assetPath.startsWith(`${assetsRoot}${path.sep}`)) return part
  const buffer = await fs.readFile(assetPath).catch((error: unknown) => {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined
    throw error
  })
  if (!buffer) return part
  return {
    ...part,
    url: `data:${part.mime};base64,${buffer.toString("base64")}`,
  } satisfies SessionV1.FilePart
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

    const type = baseEventType(entry.type)

    if (type === "message.updated" && entry.message && typeof entry.message === "object") {
      const message = entry.message as SessionV1.Info
      const existing = messages.get(message.id)
      const parts = existing?.parts ?? orphanParts.get(message.id) ?? []
      messages.set(message.id, { info: message, parts })
      orphanParts.delete(message.id)
      removedMessageIDs.delete(message.id)
      continue
    }

    if (type === "message.part.updated" && entry.part && typeof entry.part === "object") {
      const part = await resolveAssetURL(info, entry.part as SessionV1.Part)
      removedPartIDs.delete(`${part.messageID}:${part.id}`)
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

    if (type === "message.part.delta") {
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

    if (type === "message.removed") {
      const messageID = typeof entry.messageID === "string" ? entry.messageID : undefined
      if (!messageID) continue
      removedMessageIDs.add(messageID)
      messages.delete(messageID)
      orphanParts.delete(messageID)
      continue
    }

    if (type === "message.part.removed") {
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

async function applySessionUpdatedEvents(info: SessionInfo) {
  const target = path.join(sessionRoot(info), "session.jsonl")
  const raw = await fs.readFile(target, "utf8").catch((error: unknown) => {
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
    if (type === "session.next.agent.switched" && typeof entry.agent === "string") {
      const updated = timestampValue(entry.timestamp, typeof entry.at === "number" ? entry.at : 0)
      next = {
        ...next,
        agent: entry.agent,
        time: {
          ...next.time,
          updated: Math.max(next.time.updated, updated),
        },
      }
      continue
    }
    if (type === "session.next.model.switched") {
      const model = modelRef(entry.model)
      if (!model) continue
      const updated = timestampValue(entry.timestamp, typeof entry.at === "number" ? entry.at : 0)
      next = {
        ...next,
        model,
        time: {
          ...next.time,
          updated: Math.max(next.time.updated, updated),
        },
      }
      continue
    }
    if (type === "session.next.moved") {
      const location = isRecord(entry.location) ? entry.location : undefined
      const updated = timestampValue(entry.timestamp, typeof entry.at === "number" ? entry.at : 0)
      next = {
        ...next,
        // The containing directory stays authoritative so copied atree
        // directories do not keep pointing to old absolute paths.
        workspaceID:
          typeof location?.workspaceID === "string"
            ? (location.workspaceID as SessionInfo["workspaceID"])
            : next.workspaceID,
        path: typeof entry.subdirectory === "string" ? entry.subdirectory : next.path,
        time: {
          ...next.time,
          updated: Math.max(next.time.updated, updated),
        },
      }
      continue
    }
    if (type === "session.diff") {
      const summary = diffSummary(entry.diff)
      if (!summary) continue
      next = {
        ...next,
        summary,
        time: {
          ...next.time,
          updated: Math.max(next.time.updated, typeof entry.at === "number" ? entry.at : 0),
        },
      }
      continue
    }
    if (type !== "session.updated" || !isRecord(entry.patch)) continue
    const patch = entry.patch
    const time = { ...next.time }
    if (isRecord(patch.time) && "archived" in patch.time) {
      const archived = patch.time.archived
      if (typeof archived === "number") time.archived = archived
      else if (archived === null) delete time.archived
    }
    if (typeof entry.at === "number") {
      time.updated = Math.max(time.updated, entry.at)
    }
    if (isRecord(patch.time) && "compacting" in patch.time) {
      const compacting = patch.time.compacting
      if (typeof compacting === "number") time.compacting = compacting
      else if (compacting === null) delete time.compacting
    }
    next = {
      ...next,
      ...(typeof patch.title === "string" ? { title: patch.title } : {}),
      ...(isRecord(patch.metadata) ? { metadata: patch.metadata as SessionInfo["metadata"] } : {}),
      ...(Array.isArray(patch.permission) ? { permission: patch.permission as SessionInfo["permission"] } : {}),
      ...("workspaceID" in patch
        ? {
            workspaceID:
              typeof patch.workspaceID === "string" ? (patch.workspaceID as SessionInfo["workspaceID"]) : undefined,
          }
        : {}),
      ...("share" in patch
        ? { share: patch.share && typeof patch.share === "object" ? (patch.share as SessionInfo["share"]) : undefined }
        : {}),
      ...("summary" in patch
        ? {
            summary:
              patch.summary && typeof patch.summary === "object" ? (patch.summary as SessionInfo["summary"]) : undefined,
          }
        : {}),
      ...("revert" in patch
        ? {
            revert: patch.revert && typeof patch.revert === "object" ? (patch.revert as SessionInfo["revert"]) : undefined,
          }
        : {}),
      time,
    }
  }
  return next
}

function sessionInfoFromCreatedEvent(
  entry: Record<string, unknown>,
  fallbackDirectory: string,
  fallbackSessionID: SessionID,
): SessionInfo | undefined {
  if (baseEventType(entry.type) !== "session.created" || !isRecord(entry.info)) return
  const info = entry.info
  const id = typeof info.id === "string" ? info.id : fallbackSessionID
  if (id !== fallbackSessionID) return
  const time = isRecord(info.time) ? info.time : {}
  const tokens = isRecord(info.tokens) ? info.tokens : undefined
  const cache = tokens && isRecord(tokens.cache) ? tokens.cache : undefined
  const created = typeof time.created === "number" ? time.created : typeof entry.at === "number" ? entry.at : 0
  const updated =
    typeof time.updated === "number" ? time.updated : typeof entry.at === "number" ? entry.at : created
  const compacting = typeof time.compacting === "number" ? time.compacting : undefined
  const archived = typeof time.archived === "number" ? time.archived : undefined
  const metadata =
    info.metadata && typeof info.metadata === "object" && Object.keys(info.metadata).length > 0
      ? (info.metadata as SessionInfo["metadata"])
      : undefined
  return {
    id: fallbackSessionID,
    slug: typeof info.slug === "string" ? info.slug : id,
    version: typeof info.version === "string" ? info.version : "atree",
    projectID: (typeof info.projectID === "string" ? info.projectID : "global") as SessionInfo["projectID"],
    directory: fallbackDirectory,
    path: typeof info.path === "string" ? info.path : undefined,
    workspaceID:
      typeof info.workspaceID === "string" ? (info.workspaceID as SessionInfo["workspaceID"]) : undefined,
    parentID: typeof info.parentID === "string" ? (info.parentID as SessionID) : undefined,
    title: typeof info.title === "string" ? info.title : id,
    agent: typeof info.agent === "string" ? info.agent : undefined,
    model: info.model && typeof info.model === "object" ? (info.model as SessionInfo["model"]) : undefined,
    metadata,
    permission: Array.isArray(info.permission) ? (info.permission as SessionInfo["permission"]) : undefined,
    share: info.share && typeof info.share === "object" ? (info.share as SessionInfo["share"]) : undefined,
    summary: info.summary && typeof info.summary === "object" ? (info.summary as SessionInfo["summary"]) : undefined,
    revert: info.revert && typeof info.revert === "object" ? (info.revert as SessionInfo["revert"]) : undefined,
    cost: typeof info.cost === "number" ? info.cost : 0,
    tokens: {
      input: typeof tokens?.input === "number" ? tokens.input : 0,
      output: typeof tokens?.output === "number" ? tokens.output : 0,
      reasoning: typeof tokens?.reasoning === "number" ? tokens.reasoning : 0,
      cache: {
        read: typeof cache?.read === "number" ? cache.read : 0,
        write: typeof cache?.write === "number" ? cache.write : 0,
      },
    },
    time: {
      created,
      updated,
      ...(compacting !== undefined ? { compacting } : {}),
      ...(archived !== undefined ? { archived } : {}),
    },
  }
}

async function readSessionCreatedEvent(directory: string, sessionID: SessionID) {
  const target = path.join(sessionRootByID(directory, sessionID), "session.jsonl")
  const raw = await fs.readFile(target, "utf8").catch((error: unknown) => {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return ""
    throw error
  })
  let created: SessionInfo | undefined
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

export async function readSessionStore(directory: string, sessionID: SessionID) {
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

export async function findSessionStore(rootDirectory: string, sessionID: SessionID) {
  const root = await fs.realpath(rootDirectory)
  const budget = { count: 0 }

  async function walk(directory: string, depth: number): Promise<SessionInfo | undefined> {
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

export async function touchSessionStore(directory: string, sessionID: SessionID, updatedAt = Date.now()) {
  const current = await readSessionStore(directory, sessionID)
  if (!current) return
  await writeSessionStore({
    ...current,
    time: {
      ...current.time,
      updated: Math.max(updatedAt, current.time.updated + 1),
    },
  })
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
  // The containing directory is authoritative. A copied or moved atree
  // directory must not keep pointing sessions at the old absolute path stored
  // in historical meta.yaml files.
  const directory = fallbackDirectory
  const created = typeof data.createdAt === "number" ? data.createdAt : 0
  const updated = typeof data.updatedAt === "number" ? data.updatedAt : created
  const compacting = typeof data.compactingAt === "number" ? data.compactingAt : undefined
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
      ...(compacting !== undefined ? { compacting } : {}),
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
    if (!raw) {
      const recovered = await readSessionCreatedEvent(directory, entry.name as SessionID)
      if (recovered) sessions.push(recovered)
      continue
    }
    const parsed = parseMeta(raw, directory)
    if (parsed) sessions.push(parsed)
  }
  const projected = await Promise.all(sessions.map((session) => applySessionUpdatedEvents(session)))
  projected.sort((a, b) => b.time.updated - a.time.updated || b.id.localeCompare(a.id))
  return projected
}
