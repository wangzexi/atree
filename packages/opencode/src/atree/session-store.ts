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
  if (typeof value === "string") {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>
    if (typeof record.epochMillis === "number") return record.epochMillis
    if (typeof record.millis === "number") return record.millis
  }
  return fallback
}

function eventData(entry: Record<string, unknown>) {
  return isRecord(entry.data) ? entry.data : entry
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

function tokensValue(value: unknown): SessionInfo["tokens"] | undefined {
  if (!isRecord(value)) return
  const cache = isRecord(value.cache) ? value.cache : undefined
  if (
    typeof value.input !== "number" ||
    typeof value.output !== "number" ||
    typeof value.reasoning !== "number" ||
    typeof cache?.read !== "number" ||
    typeof cache.write !== "number"
  ) {
    return
  }
  return {
    input: value.input,
    output: value.output,
    reasoning: value.reasoning,
    cache: { read: cache.read, write: cache.write },
  } as SessionInfo["tokens"]
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

function partID(prefix: string, value: string) {
  return `${prefix}_${value.replace(/[^A-Za-z0-9._-]+/g, "_")}` as SessionV1.PartID
}

function messageID(prefix: string, value: string) {
  return `${prefix}_${value.replace(/[^A-Za-z0-9._-]+/g, "_")}` as SessionV1.MessageID
}

function contentText(value: unknown) {
  if (typeof value === "string") return value
  if (!Array.isArray(value)) return JSON.stringify(value ?? "")
  return value
    .map((item) => {
      if (typeof item === "string") return item
      if (isRecord(item) && typeof item.text === "string") return item.text
      return JSON.stringify(item)
    })
    .join("\n")
}

function ensureAssistantMessage(
  info: SessionInfo,
  messages: Map<string, SessionV1.WithParts>,
  input: {
    id: string
    timestamp: number
    agent?: string
    model?: SessionInfo["model"]
    parentID?: string
  },
) {
  const existing = messages.get(input.id)
  if (existing) return existing
  const model = input.model ?? info.model
  const message = {
    info: {
      id: input.id as SessionV1.MessageID,
      sessionID: info.id,
      role: "assistant",
      time: { created: input.timestamp },
      parentID: (input.parentID ?? "msg_atree_parent") as SessionV1.MessageID,
      modelID: (model?.id ?? "unknown") as SessionV1.Assistant["modelID"],
      providerID: (model?.providerID ?? "unknown") as SessionV1.Assistant["providerID"],
      ...(model?.variant ? { variant: model.variant } : {}),
      mode: input.agent ?? info.agent ?? "build",
      agent: input.agent ?? info.agent ?? "build",
      path: { cwd: info.directory, root: info.directory },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [],
  } satisfies SessionV1.WithParts
  messages.set(input.id, message)
  return message
}

function upsertAssistantPart(message: SessionV1.WithParts, part: SessionV1.Part) {
  upsertPart(message.parts, part)
}

function findToolPart(message: SessionV1.WithParts, callID: string) {
  return message.parts.find((part): part is SessionV1.ToolPart => part.type === "tool" && part.callID === callID)
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
  let lastUserMessageID: string | undefined

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
    const data = eventData(entry)
    const eventAt = timestampValue(data.timestamp, typeof entry.at === "number" ? entry.at : 0)

    if (
      (type === "session.next.prompted" ||
        type === "session.next.prompt.admitted" ||
        type === "session.next.prompt.promoted") &&
      typeof data.messageID === "string" &&
      isRecord(data.prompt)
    ) {
      const messageID = data.messageID as SessionV1.MessageID
      const prompt = data.prompt
      const created = timestampValue(data.timeCreated, eventAt)
      const model = info.model
      const message: SessionV1.WithParts = {
        info: {
          id: messageID,
          sessionID: info.id,
          role: "user",
          time: { created },
          agent: info.agent ?? "build",
          model: {
            providerID: (model?.providerID ?? "unknown") as SessionV1.User["model"]["providerID"],
            modelID: (model?.id ?? "unknown") as SessionV1.User["model"]["modelID"],
            ...(model?.variant ? { variant: model.variant } : {}),
          },
        },
        parts: [],
      }
      if (typeof prompt.text === "string") {
        message.parts.push({
          id: partID("prt_text", messageID),
          sessionID: info.id,
          messageID,
          type: "text",
          text: prompt.text,
          time: { start: created, end: created },
        } satisfies SessionV1.TextPart)
      }
      if (Array.isArray(prompt.files)) {
        for (const [index, file] of prompt.files.entries()) {
          if (!isRecord(file) || typeof file.uri !== "string" || typeof file.mime !== "string") continue
          message.parts.push({
            id: partID("prt_file", `${messageID}_${index}`),
            sessionID: info.id,
            messageID,
            type: "file",
            mime: file.mime,
            url: file.uri,
            ...(typeof file.name === "string" ? { filename: file.name } : {}),
          } satisfies SessionV1.FilePart)
        }
      }
      if (Array.isArray(prompt.agents)) {
        for (const [index, agent] of prompt.agents.entries()) {
          if (!isRecord(agent) || typeof agent.name !== "string") continue
          message.parts.push({
            id: partID("prt_agent", `${messageID}_${index}`),
            sessionID: info.id,
            messageID,
            type: "agent",
            name: agent.name,
          } satisfies SessionV1.AgentPart)
        }
      }
      messages.set(messageID, message)
      removedMessageIDs.delete(messageID)
      lastUserMessageID = messageID
      continue
    }

    if (type === "session.next.context.updated" && typeof data.messageID === "string" && typeof data.text === "string") {
      const messageID = data.messageID as SessionV1.MessageID
      const model = info.model
      messages.set(messageID, {
        info: {
          id: messageID,
          sessionID: info.id,
          role: "user",
          time: { created: eventAt },
          agent: info.agent ?? "build",
          model: {
            providerID: (model?.providerID ?? "unknown") as SessionV1.User["model"]["providerID"],
            modelID: (model?.id ?? "unknown") as SessionV1.User["model"]["modelID"],
            ...(model?.variant ? { variant: model.variant } : {}),
          },
          system: data.text,
        },
        parts: [],
      } satisfies SessionV1.WithParts)
      removedMessageIDs.delete(messageID)
      continue
    }

    if (type === "session.next.synthetic" && typeof data.messageID === "string" && typeof data.text === "string") {
      const messageID = data.messageID as SessionV1.MessageID
      const model = info.model
      messages.set(messageID, {
        info: {
          id: messageID,
          sessionID: info.id,
          role: "user",
          time: { created: eventAt },
          agent: info.agent ?? "build",
          model: {
            providerID: (model?.providerID ?? "unknown") as SessionV1.User["model"]["providerID"],
            modelID: (model?.id ?? "unknown") as SessionV1.User["model"]["modelID"],
            ...(model?.variant ? { variant: model.variant } : {}),
          },
        },
        parts: [
          {
            id: partID("prt_synthetic", messageID),
            sessionID: info.id,
            messageID,
            type: "text",
            text: data.text,
            synthetic: true,
            time: { start: eventAt, end: eventAt },
          } satisfies SessionV1.TextPart,
        ],
      } satisfies SessionV1.WithParts)
      removedMessageIDs.delete(messageID)
      continue
    }

    if (
      type === "session.next.step.started" &&
      typeof data.assistantMessageID === "string" &&
      typeof data.agent === "string"
    ) {
      const assistant = ensureAssistantMessage(info, messages, {
        id: data.assistantMessageID,
        timestamp: eventAt,
        agent: data.agent,
        model: modelRef(data.model),
        parentID: lastUserMessageID,
      })
      upsertAssistantPart(assistant, {
        id: partID("prt_00_step_start", data.assistantMessageID),
        sessionID: info.id,
        messageID: data.assistantMessageID as SessionV1.MessageID,
        type: "step-start",
        ...(typeof data.snapshot === "string" ? { snapshot: data.snapshot } : {}),
      } satisfies SessionV1.StepStartPart)
      removedMessageIDs.delete(data.assistantMessageID)
      continue
    }

    if (type === "session.next.step.ended" && typeof data.assistantMessageID === "string") {
      const assistant = ensureAssistantMessage(info, messages, {
        id: data.assistantMessageID,
        timestamp: eventAt,
        parentID: lastUserMessageID,
      })
      const tokens = tokensValue(data.tokens) ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
      const assistantInfo = assistant.info as SessionV1.Assistant
      assistant.info = {
        ...assistantInfo,
        time: { ...assistantInfo.time, completed: eventAt },
        finish: typeof data.finish === "string" ? data.finish : assistantInfo.finish,
        cost: typeof data.cost === "number" ? data.cost : assistantInfo.cost,
        tokens,
      } as SessionV1.Assistant
      upsertAssistantPart(assistant, {
        id: partID("prt_90_step_finish", data.assistantMessageID),
        sessionID: info.id,
        messageID: data.assistantMessageID as SessionV1.MessageID,
        type: "step-finish",
        reason: typeof data.finish === "string" ? data.finish : "unknown",
        ...(typeof data.snapshot === "string" ? { snapshot: data.snapshot } : {}),
        cost: typeof data.cost === "number" ? data.cost : 0,
        tokens,
      } satisfies SessionV1.StepFinishPart)
      continue
    }

    if (type === "session.next.step.failed" && typeof data.assistantMessageID === "string") {
      const assistant = ensureAssistantMessage(info, messages, {
        id: data.assistantMessageID,
        timestamp: eventAt,
        parentID: lastUserMessageID,
      })
      assistant.info = {
        ...assistant.info,
        time: { ...assistant.info.time, completed: eventAt },
        finish: "error",
        ...(isRecord(data.error) ? { error: data.error as SessionV1.Assistant["error"] } : {}),
      } as SessionV1.Assistant
      continue
    }

    if (type === "session.next.text.started" && typeof data.assistantMessageID === "string" && typeof data.textID === "string") {
      const assistant = ensureAssistantMessage(info, messages, {
        id: data.assistantMessageID,
        timestamp: eventAt,
        parentID: lastUserMessageID,
      })
      upsertAssistantPart(assistant, {
        id: partID("prt_10_text", data.textID),
        sessionID: info.id,
        messageID: data.assistantMessageID as SessionV1.MessageID,
        type: "text",
        text: "",
        time: { start: eventAt },
      } satisfies SessionV1.TextPart)
      continue
    }

    if (type === "session.next.text.ended" && typeof data.assistantMessageID === "string" && typeof data.textID === "string") {
      const assistant = ensureAssistantMessage(info, messages, {
        id: data.assistantMessageID,
        timestamp: eventAt,
        parentID: lastUserMessageID,
      })
      upsertAssistantPart(assistant, {
        id: partID("prt_10_text", data.textID),
        sessionID: info.id,
        messageID: data.assistantMessageID as SessionV1.MessageID,
        type: "text",
        text: typeof data.text === "string" ? data.text : "",
        time: { start: eventAt, end: eventAt },
      } satisfies SessionV1.TextPart)
      continue
    }

    if (
      type === "session.next.reasoning.started" &&
      typeof data.assistantMessageID === "string" &&
      typeof data.reasoningID === "string"
    ) {
      const assistant = ensureAssistantMessage(info, messages, {
        id: data.assistantMessageID,
        timestamp: eventAt,
        parentID: lastUserMessageID,
      })
      upsertAssistantPart(assistant, {
        id: partID("prt_20_reasoning", data.reasoningID),
        sessionID: info.id,
        messageID: data.assistantMessageID as SessionV1.MessageID,
        type: "reasoning",
        text: "",
        ...(isRecord(data.providerMetadata) ? { metadata: data.providerMetadata } : {}),
        time: { start: eventAt },
      } satisfies SessionV1.ReasoningPart)
      continue
    }

    if (
      type === "session.next.reasoning.ended" &&
      typeof data.assistantMessageID === "string" &&
      typeof data.reasoningID === "string"
    ) {
      const assistant = ensureAssistantMessage(info, messages, {
        id: data.assistantMessageID,
        timestamp: eventAt,
        parentID: lastUserMessageID,
      })
      upsertAssistantPart(assistant, {
        id: partID("prt_20_reasoning", data.reasoningID),
        sessionID: info.id,
        messageID: data.assistantMessageID as SessionV1.MessageID,
        type: "reasoning",
        text: typeof data.text === "string" ? data.text : "",
        ...(isRecord(data.providerMetadata) ? { metadata: data.providerMetadata } : {}),
        time: { start: eventAt, end: eventAt },
      } satisfies SessionV1.ReasoningPart)
      continue
    }

    if (
      type === "session.next.tool.input.started" &&
      typeof data.assistantMessageID === "string" &&
      typeof data.callID === "string" &&
      typeof data.name === "string"
    ) {
      const assistant = ensureAssistantMessage(info, messages, {
        id: data.assistantMessageID,
        timestamp: eventAt,
        parentID: lastUserMessageID,
      })
      upsertAssistantPart(assistant, {
        id: partID("prt_30_tool", data.callID),
        sessionID: info.id,
        messageID: data.assistantMessageID as SessionV1.MessageID,
        type: "tool",
        callID: data.callID,
        tool: data.name,
        state: { status: "pending", input: {}, raw: "" },
      } satisfies SessionV1.ToolPart)
      continue
    }

    if (type === "session.next.tool.input.ended" && typeof data.assistantMessageID === "string" && typeof data.callID === "string") {
      const assistant = ensureAssistantMessage(info, messages, {
        id: data.assistantMessageID,
        timestamp: eventAt,
        parentID: lastUserMessageID,
      })
      const tool = findToolPart(assistant, data.callID)
      if (tool && tool.state.status === "pending") tool.state.raw = typeof data.text === "string" ? data.text : ""
      continue
    }

    if (
      type === "session.next.tool.called" &&
      typeof data.assistantMessageID === "string" &&
      typeof data.callID === "string" &&
      typeof data.tool === "string"
    ) {
      const assistant = ensureAssistantMessage(info, messages, {
        id: data.assistantMessageID,
        timestamp: eventAt,
        parentID: lastUserMessageID,
      })
      const current = findToolPart(assistant, data.callID)
      const input = isRecord(data.input) ? data.input : {}
      upsertAssistantPart(assistant, {
        id: current?.id ?? partID("prt_30_tool", data.callID),
        sessionID: info.id,
        messageID: data.assistantMessageID as SessionV1.MessageID,
        type: "tool",
        callID: data.callID,
        tool: data.tool,
        metadata: isRecord(data.provider) ? (data.provider as Record<string, unknown>) : undefined,
        state: {
          status: "running",
          input,
          title: data.tool,
          time: { start: eventAt },
        },
      } satisfies SessionV1.ToolPart)
      continue
    }

    if (
      (type === "session.next.tool.progress" || type === "session.next.tool.success") &&
      typeof data.assistantMessageID === "string" &&
      typeof data.callID === "string"
    ) {
      const assistant = ensureAssistantMessage(info, messages, {
        id: data.assistantMessageID,
        timestamp: eventAt,
        parentID: lastUserMessageID,
      })
      const current = findToolPart(assistant, data.callID)
      const input = current?.state.status === "running" || current?.state.status === "completed" ? current.state.input : {}
      const output = contentText(data.content)
      upsertAssistantPart(assistant, {
        id: current?.id ?? partID("prt_30_tool", data.callID),
        sessionID: info.id,
        messageID: data.assistantMessageID as SessionV1.MessageID,
        type: "tool",
        callID: data.callID,
        tool: current?.tool ?? data.callID,
        metadata: isRecord(data.provider) ? (data.provider as Record<string, unknown>) : current?.metadata,
        state:
          type === "session.next.tool.success"
            ? {
                status: "completed",
                input,
                output,
                title: current?.tool ?? data.callID,
                metadata: {},
                time: {
                  start:
                    current?.state.status === "running" || current?.state.status === "completed"
                      ? current.state.time.start
                      : eventAt,
                  end: eventAt,
                },
              }
            : {
                status: "running",
                input,
                title: current?.tool ?? data.callID,
                time:
                  current?.state.status === "running"
                    ? current.state.time
                    : { start: eventAt },
              },
      } satisfies SessionV1.ToolPart)
      continue
    }

    if (type === "session.next.tool.failed" && typeof data.assistantMessageID === "string" && typeof data.callID === "string") {
      const assistant = ensureAssistantMessage(info, messages, {
        id: data.assistantMessageID,
        timestamp: eventAt,
        parentID: lastUserMessageID,
      })
      const current = findToolPart(assistant, data.callID)
      upsertAssistantPart(assistant, {
        id: current?.id ?? partID("prt_30_tool", data.callID),
        sessionID: info.id,
        messageID: data.assistantMessageID as SessionV1.MessageID,
        type: "tool",
        callID: data.callID,
        tool: current?.tool ?? data.callID,
        metadata: isRecord(data.provider) ? (data.provider as Record<string, unknown>) : current?.metadata,
        state: {
          status: "error",
          input:
            current?.state.status === "running" || current?.state.status === "completed" ? current.state.input : {},
          error: isRecord(data.error) && typeof data.error.message === "string" ? data.error.message : "Tool failed",
          metadata: {},
          time: {
            start:
              current?.state.status === "running" || current?.state.status === "completed"
                ? current.state.time.start
                : eventAt,
            end: eventAt,
          },
        },
      } satisfies SessionV1.ToolPart)
      continue
    }

    if (
      type === "session.next.shell.started" &&
      typeof data.messageID === "string" &&
      typeof data.callID === "string" &&
      typeof data.command === "string"
    ) {
      const assistant = ensureAssistantMessage(info, messages, {
        id: data.messageID,
        timestamp: eventAt,
        parentID: lastUserMessageID,
      })
      upsertAssistantPart(assistant, {
        id: partID("prt_30_tool", data.callID),
        sessionID: info.id,
        messageID: data.messageID as SessionV1.MessageID,
        type: "tool",
        callID: data.callID,
        tool: "bash",
        state: {
          status: "running",
          input: { command: data.command },
          title: "bash",
          time: { start: eventAt },
        },
      } satisfies SessionV1.ToolPart)
      removedMessageIDs.delete(data.messageID)
      continue
    }

    if (type === "session.next.shell.ended" && typeof data.callID === "string") {
      const callID = data.callID
      const assistant = [...messages.values()]
        .filter((item) => item.info.role === "assistant")
        .find((item) => findToolPart(item, callID))
      if (!assistant) continue
      const current = findToolPart(assistant, callID)
      const input = current?.state.status === "running" || current?.state.status === "completed" ? current.state.input : {}
      upsertAssistantPart(assistant, {
        id: current?.id ?? partID("prt_30_tool", callID),
        sessionID: info.id,
        messageID: assistant.info.id,
        type: "tool",
        callID,
        tool: current?.tool ?? "bash",
        state: {
          status: "completed",
          input,
          output: typeof data.output === "string" ? data.output : "",
          title: current?.tool ?? "bash",
          metadata: {},
          time: {
            start:
              current?.state.status === "running" || current?.state.status === "completed"
                ? current.state.time.start
                : eventAt,
            end: eventAt,
          },
        },
      } satisfies SessionV1.ToolPart)
      assistant.info = {
        ...(assistant.info as SessionV1.Assistant),
        time: { ...(assistant.info as SessionV1.Assistant).time, completed: eventAt },
      }
      continue
    }

    if (
      type === "session.next.compaction.started" &&
      typeof data.messageID === "string" &&
      (data.reason === "auto" || data.reason === "manual")
    ) {
      const model = info.model
      const user: SessionV1.WithParts = {
        info: {
          id: data.messageID as SessionV1.MessageID,
          sessionID: info.id,
          role: "user",
          time: { created: eventAt },
          agent: info.agent ?? "build",
          model: {
            providerID: (model?.providerID ?? "unknown") as SessionV1.User["model"]["providerID"],
            modelID: (model?.id ?? "unknown") as SessionV1.User["model"]["modelID"],
            ...(model?.variant ? { variant: model.variant } : {}),
          },
        },
        parts: [
          {
            id: partID("prt_compaction", data.messageID),
            sessionID: info.id,
            messageID: data.messageID as SessionV1.MessageID,
            type: "compaction",
            auto: data.reason === "auto",
          } satisfies SessionV1.CompactionPart,
        ],
      }
      messages.set(data.messageID, user)
      removedMessageIDs.delete(data.messageID)
      lastUserMessageID = data.messageID
      continue
    }

    if (
      type === "session.next.compaction.ended" &&
      typeof data.messageID === "string" &&
      typeof data.text === "string"
    ) {
      const user = messages.get(data.messageID)
      if (!user) {
        const model = info.model
        messages.set(data.messageID, {
          info: {
            id: data.messageID as SessionV1.MessageID,
            sessionID: info.id,
            role: "user",
            time: { created: eventAt },
            agent: info.agent ?? "build",
            model: {
              providerID: (model?.providerID ?? "unknown") as SessionV1.User["model"]["providerID"],
              modelID: (model?.id ?? "unknown") as SessionV1.User["model"]["modelID"],
              ...(model?.variant ? { variant: model.variant } : {}),
            },
          },
          parts: [
            {
              id: partID("prt_compaction", data.messageID),
              sessionID: info.id,
              messageID: data.messageID as SessionV1.MessageID,
              type: "compaction",
              auto: data.reason === "auto",
            } satisfies SessionV1.CompactionPart,
          ],
        } satisfies SessionV1.WithParts)
      }
      const summaryID = messageID("msg_atree_compaction_summary", data.messageID)
      const assistant = ensureAssistantMessage(info, messages, {
        id: summaryID,
        timestamp: eventAt,
        agent: "compaction",
        parentID: data.messageID,
      })
      assistant.info = {
        ...(assistant.info as SessionV1.Assistant),
        summary: true,
        time: { ...(assistant.info as SessionV1.Assistant).time, completed: eventAt },
        finish: "stop",
      }
      upsertAssistantPart(assistant, {
        id: partID("prt_10_text", summaryID),
        sessionID: info.id,
        messageID: summaryID,
        type: "text",
        text: data.text,
        synthetic: true,
        time: { start: eventAt, end: eventAt },
      } satisfies SessionV1.TextPart)
      continue
    }

    if (type === "message.updated" && data.message && typeof data.message === "object") {
      const message = data.message as SessionV1.Info
      const existing = messages.get(message.id)
      const parts = existing?.parts ?? orphanParts.get(message.id) ?? []
      messages.set(message.id, { info: message, parts })
      orphanParts.delete(message.id)
      removedMessageIDs.delete(message.id)
      if (message.role === "user") lastUserMessageID = message.id
      continue
    }

    if (type === "message.part.updated" && data.part && typeof data.part === "object") {
      const part = await resolveAssetURL(info, data.part as SessionV1.Part)
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
      const messageID = typeof data.messageID === "string" ? data.messageID : undefined
      const partID = typeof data.partID === "string" ? data.partID : undefined
      const field = typeof data.field === "string" ? data.field : undefined
      const delta = typeof data.delta === "string" ? data.delta : undefined
      if (!messageID || !partID || !field || delta === undefined) continue
      const part =
        messages.get(messageID)?.parts.find((item) => item.id === partID) ??
        orphanParts.get(messageID)?.find((item) => item.id === partID)
      if (part) appendPartDelta(part, field, delta)
      continue
    }

    if (type === "message.removed") {
      const messageID = typeof data.messageID === "string" ? data.messageID : undefined
      if (!messageID) continue
      removedMessageIDs.add(messageID)
      messages.delete(messageID)
      orphanParts.delete(messageID)
      continue
    }

    if (type === "message.part.removed") {
      const messageID = typeof data.messageID === "string" ? data.messageID : undefined
      const partID = typeof data.partID === "string" ? data.partID : undefined
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
    const data = eventData(entry)
    if (type === "session.next.agent.switched" && typeof data.agent === "string") {
      const updated = timestampValue(data.timestamp, typeof entry.at === "number" ? entry.at : 0)
      next = {
        ...next,
        agent: data.agent,
        time: {
          ...next.time,
          updated: Math.max(next.time.updated, updated),
        },
      }
      continue
    }
    if (type === "session.next.model.switched") {
      const model = modelRef(data.model)
      if (!model) continue
      const updated = timestampValue(data.timestamp, typeof entry.at === "number" ? entry.at : 0)
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
      const location = isRecord(data.location) ? data.location : undefined
      const updated = timestampValue(data.timestamp, typeof entry.at === "number" ? entry.at : 0)
      next = {
        ...next,
        // The containing directory stays authoritative so copied atree
        // directories do not keep pointing to old absolute paths.
        workspaceID:
          typeof location?.workspaceID === "string"
            ? (location.workspaceID as SessionInfo["workspaceID"])
            : next.workspaceID,
        path: typeof data.subdirectory === "string" ? data.subdirectory : next.path,
        time: {
          ...next.time,
          updated: Math.max(next.time.updated, updated),
        },
      }
      continue
    }
    if (type === "session.diff") {
      const summary = diffSummary(data.diff)
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
    if (type !== "session.updated") continue
    const patch = isRecord(data.patch) ? data.patch : isRecord(data.info) ? data.info : undefined
    if (!patch) continue
    const time = { ...next.time }
    if (isRecord(patch.time) && "archived" in patch.time) {
      const archived = patch.time.archived
      if (typeof archived === "number") time.archived = archived
      else if (archived === null) delete time.archived
    }
    if (isRecord(patch.time) && typeof patch.time.created === "number") {
      time.created = patch.time.created
    }
    if (isRecord(patch.time) && typeof patch.time.updated === "number") {
      time.updated = Math.max(time.updated, patch.time.updated)
    }
    if (typeof entry.at === "number") {
      time.updated = Math.max(time.updated, entry.at)
    }
    if (isRecord(patch.time) && "compacting" in patch.time) {
      const compacting = patch.time.compacting
      if (typeof compacting === "number") time.compacting = compacting
      else if (compacting === null) delete time.compacting
    }
    const tokens = tokensValue(patch.tokens)
    next = {
      ...next,
      ...(typeof patch.title === "string" ? { title: patch.title } : {}),
      ...(typeof patch.projectID === "string" ? { projectID: patch.projectID as SessionInfo["projectID"] } : {}),
      ...("parentID" in patch
        ? { parentID: typeof patch.parentID === "string" ? (patch.parentID as SessionInfo["parentID"]) : undefined }
        : {}),
      ...("path" in patch ? { path: typeof patch.path === "string" ? patch.path : undefined } : {}),
      ...("agent" in patch ? { agent: typeof patch.agent === "string" ? patch.agent : undefined } : {}),
      ...("model" in patch ? { model: modelRef(patch.model) } : {}),
      ...(typeof patch.cost === "number" ? { cost: patch.cost } : {}),
      ...(tokens ? { tokens } : {}),
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
  const data = eventData(entry)
  if (baseEventType(entry.type) !== "session.created" || !isRecord(data.info)) return
  const info = data.info
  const id = typeof info.id === "string" ? info.id : fallbackSessionID
  if (id !== fallbackSessionID) return
  const time = isRecord(info.time) ? info.time : {}
  const tokens = isRecord(info.tokens) ? info.tokens : undefined
  const cache = tokens && isRecord(tokens.cache) ? tokens.cache : undefined
  const eventAt = timestampValue(data.at, timestampValue(entry.at, 0))
  const created = typeof time.created === "number" ? time.created : eventAt
  const updated =
    typeof time.updated === "number" ? time.updated : eventAt || created
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

export async function readSessionStoresDeep(rootDirectory: string) {
  const root = await fs.realpath(rootDirectory)
  const budget = { count: 0 }
  const sessions: SessionInfo[] = []

  async function walk(directory: string, depth: number) {
    if (budget.count++ >= FindMaxNodes) return
    sessions.push(...(await readSessionStores(directory)))
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
      if (entry.name === ".agents" || IgnoredDirectories.has(entry.name)) continue
      await walk(path.join(directory, entry.name), depth + 1)
    }
  }

  await walk(root, 0)
  sessions.sort((a, b) => b.time.updated - a.time.updated || b.id.localeCompare(a.id))
  return sessions
}
