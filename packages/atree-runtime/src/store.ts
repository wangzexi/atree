import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises"
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  AuthStorage,
  createAgentSession,
  CURRENT_SESSION_VERSION,
  DefaultResourceLoader,
  defineTool,
  getAgentDir,
  loadSkills,
  ModelRegistry,
  parseSessionEntries,
  SessionManager,
  stripFrontmatter,
} from "@mariozechner/pi-coding-agent"
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@mariozechner/pi-ai"
import { Cron } from "croner"
import { homedir } from "node:os"
import { parse as parseYaml, stringify as stringifyYaml } from "yaml"
import { id } from "./ids"

const ATREE_VERSION = 1

type Json = Record<string, unknown>

type FauxRegistration = ReturnType<typeof registerFauxProvider>
type RuntimeEventPublisher = (type: string, properties: Json) => void
type PiExecutionMode = "none" | "faux" | "real"

let fauxRegistration: FauxRegistration | undefined

export type ScheduleMeta =
  | {
      id: string
      kind: "at"
      run_at: string | number
      message: string
      created_at: string
      last_ran_at: string | null
      last_run_status: "ran" | "skipped" | null
    }
  | {
      id: string
      kind: "cron"
      expression: string
      message: string
      created_at: string
      last_ran_at: string | null
    last_run_status: "ran" | "skipped" | null
  }

export type SessionShare = {
  url: string
}

export type SessionRevert = {
  messageID: string
  partID?: string
  snapshot?: string
  diff?: string
}

export type SessionMeta = {
  version: number
  id: string
  title: string
  icon?: string
  metadata?: Json
  created_at: string
  updated_at: string
  archived_at: string | null
  share?: SessionShare
  revert?: SessionRevert
  schedule?: ScheduleMeta
}

export type SessionInfo = {
  id: string
  slug: string
  projectID: string
  directory: string
  path?: string
  parentID?: string
  title: string
  version: string
  metadata?: Json
  time: {
    created: number
    updated: number
    archived?: number
  }
  share?: SessionShare
  revert?: SessionRevert
  cost: number
  tokens: {
    input: number
    output: number
    reasoning: number
    cache: {
      read: number
      write: number
    }
  }
}

export type NativeSessionInfo = {
  id: string
  directory: string
  paths: {
    root: string
    meta: string
    sessionJsonl: string
    assets: string
  }
  meta: SessionMeta
}

type MessagePart = {
  id: string
  type: "text" | "file" | "agent" | "reasoning" | "tool"
  sessionID: string
  messageID: string
  text?: string
  mime?: string
  url?: string
  filename?: string
  callID?: string
  tool?: string
  state?: {
    status: "running" | "completed" | "error"
    input?: unknown
    output?: unknown
    title?: string
    error?: string
    metadata?: Json
    time?: { start?: number; end?: number }
  }
  time?: { start?: number; end?: number }
}

type MessageInfo = {
  id: string
  sessionID: string
  role: "user" | "assistant"
  time: { created: number; completed?: number }
  agent: string
  model?: { providerID: string; modelID: string; variant?: string }
  parentID?: string
  modelID?: string
  providerID?: string
  mode?: string
  path?: { cwd: string; root: string }
  cost?: number
  tokens?: {
    total?: number
    input: number
    output: number
    reasoning: number
    cache: { read: number; write: number }
  }
}

export type MessageWithParts = {
  info: MessageInfo
  parts: MessagePart[]
}

export type ScheduleInfo = {
  id: string
  sessionID: string
  kind: "once" | "recurring"
  expression: string
  runAt: number | null
  message: string
  createdAt: number
  lastRanAt: number | null
  lastRunStatus: "ran" | "skipped" | null
  nextRun: number | null
}

export type DueSchedule = {
  sessionID: string
  schedule: ScheduleMeta
  info: ScheduleInfo
  runAt: number
}

export type SkillInfo = {
  name: string
  description?: string
  location: string
  content: string
}

function timestamp(value: unknown) {
  if (!value) return undefined
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (value instanceof Date) {
    const time = value.getTime()
    return Number.isFinite(time) ? time : undefined
  }
  if (typeof value !== "string") return undefined
  const time = new Date(value).getTime()
  return Number.isFinite(time) ? time : undefined
}

function slug(input: string) {
  return (
    input
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "session"
  )
}

function projectID(directory: string) {
  return createHash("sha1").update(directory).digest("hex")
}

async function readJsonYaml<T>(path: string): Promise<T | undefined> {
  try {
    const parsed = parseYaml(await readFile(path, "utf8"), { prettyErrors: false }) as unknown
    return isRecord(parsed) ? (parsed as T) : undefined
  } catch {
    return undefined
  }
}

async function writeJsonYaml(path: string, value: unknown) {
  await mkdir(join(path, ".."), { recursive: true })
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(
    tmp,
    stringifyYaml(value, {
      aliasDuplicateObjects: false,
      lineWidth: 0,
      sortMapEntries: false,
    }),
  )
  await rename(tmp, path)
}

function atreeDir(directory: string) {
  return join(directory, ".agents", "atree")
}

function sessionsDir(directory: string) {
  return join(atreeDir(directory), "sessions")
}

function sessionDir(directory: string, sessionID: string) {
  return join(sessionsDir(directory), sessionID)
}

function metaPath(directory: string, sessionID: string) {
  return join(sessionDir(directory, sessionID), "meta.yaml")
}

function sessionPath(directory: string, sessionID: string) {
  return join(sessionDir(directory, sessionID), "session.jsonl")
}

function assetsDir(directory: string, sessionID: string) {
  return join(sessionDir(directory, sessionID), "assets")
}

function rootMetaPath(directory: string) {
  return join(atreeDir(directory), "meta.yaml")
}

function atreeSkillRoots(directory: string) {
  const roots: string[] = []
  const seen = new Set<string>()
  const add = (path: string) => {
    const resolved = resolve(path)
    if (seen.has(resolved) || !existsSync(resolved)) return
    seen.add(resolved)
    roots.push(resolved)
  }

  add(join(homedir(), ".agents", "skills"))
  let current = resolve(directory)
  while (true) {
    add(join(current, ".agents", "skills"))
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return roots
}

async function createAtreeResourceLoader(directory: string) {
  const agentDir = getAgentDir()
  const resourceLoader = new DefaultResourceLoader({
    cwd: directory,
    agentDir,
    additionalSkillPaths: atreeSkillRoots(directory),
  })
  await resourceLoader.reload()
  return resourceLoader
}

function openPiSession(directory: string, sessionID: string) {
  return SessionManager.open(sessionPath(directory, sessionID), sessionDir(directory, sessionID), directory)
}

async function ensureSessionHeaderCwd(directory: string, sessionID: string) {
  const path = sessionPath(directory, sessionID)
  let content = ""
  try {
    content = await readFile(path, "utf8")
  } catch {
    return
  }

  const newlineIndex = content.indexOf("\n")
  const firstLine = newlineIndex === -1 ? content.trimEnd() : content.slice(0, newlineIndex)
  if (!firstLine) return

  let header: Json
  try {
    header = JSON.parse(firstLine) as Json
  } catch {
    return
  }
  if (header.type !== "session") return

  const next = {
    ...header,
    id: typeof header.id === "string" ? header.id : sessionID,
    version: typeof header.version === "number" ? header.version : CURRENT_SESSION_VERSION,
    cwd: directory,
  }
  if (header.id === next.id && header.version === next.version && header.cwd === next.cwd) return

  const rest = newlineIndex === -1 ? "\n" : content.slice(newlineIndex)
  await writeFile(path, `${JSON.stringify(next)}${rest}`)
}

function flushPiSession(manager: SessionManager) {
  const rewriteFile = (manager as unknown as { _rewriteFile?: () => void })._rewriteFile
  if (typeof rewriteFile !== "function") {
    throw new Error("Pi SessionManager no longer exposes _rewriteFile; update atree session.jsonl flush logic")
  }
  rewriteFile.call(manager)
}

function piExecutionMode(): PiExecutionMode {
  const value = process.env.ATREE_PI_EXECUTION?.trim()
  if (value === "none" || value === "") return "none"
  if (value === "faux") return "faux"
  return "real"
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function fauxPromptDelayMs() {
  const value = Number(process.env.ATREE_PI_FAUX_PROMPT_DELAY_MS ?? "")
  if (!Number.isFinite(value) || value <= 0) return 0
  return Math.min(value, 60_000)
}

function getFauxRegistration() {
  if (!fauxRegistration) {
    fauxRegistration = registerFauxProvider({
      provider: "atree-faux",
      api: "atree-faux",
      tokensPerSecond: 0,
      tokenSize: { min: 1024, max: 1024 },
    })
  }
  return fauxRegistration
}

const atreeEchoTool = defineTool({
  name: "atree_echo",
  label: "ATree Echo",
  description: "Echoes text for atree Pi contract tests.",
  parameters: {
    type: "object",
    properties: {
      text: { type: "string" },
    },
    required: ["text"],
    additionalProperties: false,
  },
  async execute(_toolCallId, params, _signal, onUpdate) {
    const text = typeof params.text === "string" ? params.text : ""
    const details = { output: text }
    onUpdate?.({
      content: [{ type: "text", text: `echoing ${text}` }],
      details: { output: `echoing ${text}` },
    })
    return {
      content: [{ type: "text", text }],
      details,
    }
  },
})

type FauxToolPrompt = "echo" | "read" | "write" | "edit" | "bash"

function createFauxRuntime(responseText: string, options?: { toolPrompt?: FauxToolPrompt }) {
  const faux = getFauxRegistration()
  faux.appendResponses(
    options?.toolPrompt === "echo"
      ? [
          fauxAssistantMessage([fauxToolCall("atree_echo", { text: "tool payload" }, { id: "tool_contract_echo" })], {
            stopReason: "toolUse",
          }),
          fauxAssistantMessage(responseText),
        ]
      : options?.toolPrompt === "read"
        ? [
            fauxAssistantMessage(
              [fauxToolCall("read", { path: "contract-read.txt", limit: 20 }, { id: "tool_contract_read" })],
              {
                stopReason: "toolUse",
              },
            ),
            fauxAssistantMessage(responseText),
          ]
        : options?.toolPrompt === "write"
          ? [
              fauxAssistantMessage(
                [
                  fauxToolCall(
                    "write",
                    { path: "contract-write.txt", content: "atree builtin write contract content\n" },
                    { id: "tool_contract_write" },
                  ),
                ],
                {
                  stopReason: "toolUse",
                },
              ),
              fauxAssistantMessage(responseText),
            ]
          : options?.toolPrompt === "edit"
            ? [
                fauxAssistantMessage(
                  [
                    fauxToolCall(
                      "edit",
                      {
                        path: "contract-edit.txt",
                        edits: [
                          {
                            oldText: "before edit",
                            newText: "after edit",
                          },
                        ],
                      },
                      { id: "tool_contract_edit" },
                    ),
                  ],
                  {
                    stopReason: "toolUse",
                  },
                ),
                fauxAssistantMessage(responseText),
              ]
            : options?.toolPrompt === "bash"
              ? [
                  fauxAssistantMessage(
                    [
                      fauxToolCall(
                        "bash",
                        { command: "printf atree-bash-contract-output" },
                        { id: "tool_contract_bash" },
                      ),
                    ],
                    {
                      stopReason: "toolUse",
                    },
                  ),
                  fauxAssistantMessage(responseText),
                ]
              : [fauxAssistantMessage(responseText)],
  )
  const model = faux.getModel()
  if (!model) throw new Error("Faux model is unavailable")

  const authStorage = AuthStorage.inMemory({
    [model.provider]: { type: "api_key", key: "atree-faux" },
  })
  const modelRegistry = ModelRegistry.inMemory(authStorage)
  modelRegistry.registerProvider(model.provider, {
    name: "atree faux",
    api: model.api,
    baseUrl: model.baseUrl,
    apiKey: "atree-faux",
    models: [
      {
        id: model.id,
        name: model.name,
        api: model.api,
        baseUrl: model.baseUrl,
        reasoning: model.reasoning,
        input: model.input,
        cost: model.cost,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
      },
    ],
  })

  return { authStorage, modelRegistry, model }
}

function defaultTokens() {
  return {
    input: 0,
    output: 0,
    reasoning: 0,
    cache: {
      read: 0,
      write: 0,
    },
  }
}

function sessionIconFromMetadata(metadata: Json | undefined) {
  if (!isRecord(metadata?.atree)) return undefined
  const emoji = metadata.atree.emoji
  return typeof emoji === "string" && emoji.trim() ? emoji : undefined
}

function sessionMetadata(meta: SessionMeta) {
  if (!meta.icon) return meta.metadata
  const metadata = isRecord(meta.metadata) ? meta.metadata : {}
  const atree = isRecord(metadata.atree) ? metadata.atree : {}
  return {
    ...metadata,
    atree: {
      ...atree,
      emoji: meta.icon,
    },
  }
}

function toSessionInfo(directory: string, meta: SessionMeta): SessionInfo {
  const created = timestamp(meta.created_at) ?? Date.now()
  const updated = timestamp(meta.updated_at) ?? created
  const archived = timestamp(meta.archived_at)
  return {
    id: meta.id,
    slug: slug(meta.title),
    projectID: projectID(directory),
    directory,
    path: relative(directory, sessionDir(directory, meta.id)) || undefined,
    title: meta.title,
    version: "atree-pi-spike",
    metadata: sessionMetadata(meta),
    time: {
      created,
      updated,
      ...(archived !== undefined ? { archived } : {}),
    },
    ...(meta.share ? { share: meta.share } : {}),
    ...(meta.revert ? { revert: meta.revert } : {}),
    cost: 0,
    tokens: defaultTokens(),
  }
}

function toNativeSessionInfo(directory: string, meta: SessionMeta): NativeSessionInfo {
  return {
    id: meta.id,
    directory,
    paths: {
      root: sessionDir(directory, meta.id),
      meta: metaPath(directory, meta.id),
      sessionJsonl: sessionPath(directory, meta.id),
      assets: assetsDir(directory, meta.id),
    },
    meta,
  }
}

function toScheduleInfo(sessionID: string, schedule: ScheduleMeta): ScheduleInfo {
  const createdAt = timestamp(schedule.created_at) ?? Date.now()
  const lastRanAt = timestamp(schedule.last_ran_at) ?? null
  if (schedule.kind === "at") {
    const runAt = atScheduleRunAt(schedule) ?? Date.now()
    return {
      id: schedule.id,
      sessionID,
      kind: "once",
      expression: new Date(runAt).toISOString(),
      runAt,
      message: schedule.message,
      createdAt,
      lastRanAt,
      lastRunStatus: schedule.last_run_status,
      nextRun: runAt > Date.now() ? runAt : null,
    }
  }
  return {
    id: schedule.id,
    sessionID,
    kind: "recurring",
    expression: schedule.expression,
    runAt: null,
    message: schedule.message,
    createdAt,
    lastRanAt,
    lastRunStatus: schedule.last_run_status,
    nextRun: nextCronRun(schedule),
  }
}

function atScheduleRunAt(schedule: Extract<ScheduleMeta, { kind: "at" }>) {
  return timestamp(schedule.run_at)
}

function nextCronRun(schedule: Extract<ScheduleMeta, { kind: "cron" }>) {
  const baseline = timestamp(schedule.last_ran_at) ?? timestamp(schedule.created_at) ?? Date.now()
  try {
    const cron = new Cron(schedule.expression, { paused: true })
    const next = cron.nextRun(new Date(baseline))?.getTime()
    cron.stop()
    return typeof next === "number" && Number.isFinite(next) ? next : null
  } catch {
    return null
  }
}

function normalizeCronExpression(value: string | undefined) {
  const expression = value?.trim() || "* * * * *"
  try {
    const cron = new Cron(expression, { paused: true })
    const next = cron.nextRun()
    cron.stop()
    if (!next) throw new Error("expression does not produce a future run")
    return expression
  } catch (error) {
    throw new Response(
      JSON.stringify({
        message: `Invalid cron expression: ${expression}`,
        detail: error instanceof Error ? error.message : String(error),
      }),
      { status: 400 },
    )
  }
}

function textFromPart(part: unknown) {
  if (!part || typeof part !== "object") return ""
  const next = part as { type?: unknown; text?: unknown }
  if (next.type !== "text") return ""
  return typeof next.text === "string" ? next.text : ""
}

function requestText(parts: unknown) {
  if (!Array.isArray(parts)) return ""
  return parts.map(textFromPart).filter(Boolean).join("\n")
}

async function requestContent(directory: string, sessionID: string, parts: unknown) {
  if (!Array.isArray(parts)) return [] as Json[]
  const content: Json[] = []
  for (const part of parts) {
    if (!isRecord(part)) continue
    if (part.type === "text") {
      content.push({ type: "text", text: typeof part.text === "string" ? part.text : "" })
      continue
    }
    if (part.type === "file") content.push(await storeFilePart(directory, sessionID, part))
  }
  return content
}

async function storeFilePart(directory: string, sessionID: string, part: Json) {
  const filename = safeFilename(typeof part.filename === "string" ? part.filename : "asset")
  const fallbackMime = typeof part.mime === "string" ? part.mime : "application/octet-stream"
  const url = typeof part.url === "string" ? part.url : ""
  const data = parseDataUrl(url)
  if (data) {
    const mime = data.mime ?? fallbackMime
    return storeAssetBytes(directory, sessionID, {
      bytes: data.bytes,
      filename,
      mime,
    })
  }

  const localPath = localFilePathFromPart(directory, part, url)
  if (localPath) {
    try {
      return await storeAssetBytes(directory, sessionID, {
        bytes: await readFile(localPath),
        filename: safeFilename(filename || basename(localPath)),
        mime: fallbackMime,
      })
    } catch {
      // Preserve unresolved local references instead of failing the prompt.
    }
  }

  return {
    type: "file",
    path: url,
    mime: fallbackMime,
    filename,
  }
}

async function storeAssetBytes(
  directory: string,
  sessionID: string,
  input: { bytes: Buffer; filename: string; mime: string },
) {
  const filename = safeFilename(input.filename)
  const mime = input.mime
  const assetFilename = assetFilenameFor(filename, mime)
  await mkdir(assetsDir(directory, sessionID), { recursive: true })
  await writeFile(join(assetsDir(directory, sessionID), assetFilename), input.bytes)
  return {
    type: "file",
    path: `assets/${assetFilename}`,
    mime,
    filename,
  }
}

function localFilePathFromPart(directory: string, part: Json, url: string) {
  if (url.startsWith("file://")) {
    try {
      return fileURLToPath(new URL(url))
    } catch {
      return undefined
    }
  }
  if (url && isAbsolute(url)) return url
  const source = part.source
  if (!isRecord(source) || typeof source.path !== "string" || !source.path) return undefined
  return isAbsolute(source.path) ? source.path : resolve(directory, source.path)
}

function safeFilename(value: string) {
  const name = basename(value).replace(/[^A-Za-z0-9._-]+/g, "_")
  return name && name !== "." && name !== ".." ? name : "asset"
}

function assetFilenameFor(filename: string, mime: string) {
  const extension = extname(filename) || extensionForMime(mime)
  const base = safeFilename(filename.replace(/\.[^.]+$/, "")) || "asset"
  return `${id("asset")}-${base}${extension}`
}

function extensionForMime(mime: string) {
  if (mime === "image/png") return ".png"
  if (mime === "image/jpeg") return ".jpg"
  if (mime === "image/webp") return ".webp"
  if (mime === "image/gif") return ".gif"
  if (mime === "application/pdf") return ".pdf"
  if (mime === "text/plain") return ".txt"
  return ".bin"
}

function parseDataUrl(url: string) {
  const match = url.match(/^data:([^;,]+)?((?:;[^,]+)*),(.*)$/s)
  if (!match) return
  const mime = match[1] || "application/octet-stream"
  const flags = match[2] ?? ""
  const body = match[3] ?? ""
  return {
    mime,
    bytes: flags.includes(";base64") ? Buffer.from(body, "base64") : Buffer.from(decodeURIComponent(body), "utf8"),
  }
}

function messageID(entryID: string) {
  return `msg_${entryID}`
}

function partID(messageID: string, contentIndex = 0, type = "text") {
  return `${messageID}_part_${contentIndex}_${type}`
}

function textContentParts(content: unknown) {
  if (typeof content === "string") return [{ type: "text", text: content }]
  if (!Array.isArray(content)) return []
  return content.filter(isTextContent)
}

function userContentParts(content: unknown) {
  if (typeof content === "string") return [{ type: "text" as const, text: content }]
  if (!Array.isArray(content)) return []
  return content.filter(
    (
      part,
    ): part is { type: "text"; text: string } | { type: "file"; path: string; mime?: string; filename?: string } => {
      return isTextContent(part) || isFileContent(part)
    },
  )
}

function assistantParts(content: unknown) {
  if (!Array.isArray(content)) return []
  return content.flatMap((part, index): Array<{ index: number; type: "text" | "reasoning"; text: string }> => {
    if (isTextContent(part)) return [{ index, type: "text", text: part.text }]
    if (isThinkingContent(part)) return [{ index, type: "reasoning", text: part.thinking }]
    return []
  })
}

function assistantContentParts(
  nextMessageID: string,
  sessionID: string,
  content: unknown,
  toolResults: Map<string, Json>,
  created: number,
): MessagePart[] {
  if (!Array.isArray(content)) return []
  return content.flatMap((part, index): MessagePart[] => {
    if (isTextContent(part)) {
      return [
        {
          id: partID(nextMessageID, index, "text"),
          sessionID,
          messageID: nextMessageID,
          type: "text",
          text: part.text,
          time: { start: created, end: created },
        },
      ]
    }
    if (isThinkingContent(part)) {
      return [
        {
          id: partID(nextMessageID, index, "reasoning"),
          sessionID,
          messageID: nextMessageID,
          type: "reasoning",
          text: part.thinking,
          time: { start: created, end: created },
        },
      ]
    }
    if (isToolCallContent(part)) {
      const result = toolResults.get(part.id)
      const isError = Boolean(result?.isError)
      return [
        {
          id: partID(nextMessageID, index, `tool_${part.id}`),
          sessionID,
          messageID: nextMessageID,
          type: "tool",
          callID: part.id,
          tool: part.name,
          state: {
            status: result ? (isError ? "error" : "completed") : "running",
            input: part.arguments,
            ...(result
              ? isError
                ? { error: toolResultOutput(result) }
                : { output: toolResultOutput(result), title: part.name }
              : {}),
            metadata: {},
            time: {
              start: created,
              ...(result
                ? {
                    end:
                      typeof result.timestamp === "number"
                        ? result.timestamp
                        : (timestamp(String(result.timestamp)) ?? created),
                  }
                : {}),
            },
          },
        },
      ]
    }
    return []
  })
}

function contentText(content: unknown) {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .flatMap((part) => {
      if (!isRecord(part)) return []
      if (part.type === "text" && typeof part.text === "string") return [part.text]
      if (part.type === "image") return ["[image]"]
      return []
    })
    .join("\n")
}

function toolOutput(result: unknown) {
  if (!isRecord(result)) return ""
  const details = result.details
  if (isRecord(details) && typeof details.output === "string") return details.output
  const content = contentText(result.content)
  if (content) return content
  return JSON.stringify(result)
}

function toolResultOutput(message: Json | undefined) {
  if (!message) return ""
  const details = message.details
  if (isRecord(details) && typeof details.output === "string") return details.output
  const content = contentText(message.content)
  if (content) return content
  return JSON.stringify(message)
}

function usageTokens(usage: Json | undefined) {
  return {
    input: typeof usage?.input === "number" ? usage.input : 0,
    output: typeof usage?.output === "number" ? usage.output : 0,
    reasoning: 0,
    cache: {
      read: typeof usage?.cacheRead === "number" ? usage.cacheRead : 0,
      write: typeof usage?.cacheWrite === "number" ? usage.cacheWrite : 0,
    },
    ...(typeof usage?.totalTokens === "number" ? { total: usage.totalTokens } : {}),
  }
}

function usageCost(usage: Json | undefined) {
  const cost = usage?.cost
  if (!isRecord(cost)) return 0
  return typeof cost.total === "number" ? cost.total : 0
}

function piMessageInfo(
  directory: string,
  sessionID: string,
  nextMessageID: string,
  message: Json,
  completed?: boolean,
  parentID?: string,
): MessageInfo {
  const created = typeof message.timestamp === "number" ? message.timestamp : Date.now()
  if (message.role === "assistant") {
    const usage = isRecord(message.usage) ? message.usage : undefined
    return {
      id: nextMessageID,
      sessionID,
      role: "assistant",
      time: { created, ...(completed ? { completed: Date.now() } : {}) },
      ...(parentID ? { parentID } : {}),
      modelID: typeof message.model === "string" ? message.model : "default",
      providerID: typeof message.provider === "string" ? message.provider : "pi",
      mode: "build",
      agent: "pi",
      path: { cwd: directory, root: directory },
      cost: usageCost(usage),
      tokens: usageTokens(usage),
    }
  }
  return {
    id: nextMessageID,
    sessionID,
    role: "user",
    time: { created, ...(completed ? { completed: Date.now() } : {}) },
    agent: userMessageAgent(message),
    model: { providerID: "pi", modelID: "default" },
  }
}

function userMessageAgent(message: Json) {
  const source = message.source
  return isRecord(source) && source.type === "schedule" ? "automation" : "pi"
}

function patchSessionMessageIDs(
  sessionManager: SessionManager,
  entryIDs: WeakMap<object, string>,
  source?: Json,
  userContent?: Json[],
) {
  const manager = sessionManager as unknown as {
    appendMessage: (message: unknown) => string
    getLeafId: () => string | null
    _appendEntry?: (entry: unknown) => void
  }
  const original = manager.appendMessage.bind(sessionManager)
  manager.appendMessage = (message: unknown) => {
    if (!isRecord(message)) return original(message)
    if (message.role === "user") {
      if (userContent?.length) message.content = userContent
      if (isRecord(source) && !isRecord(message.source)) message.source = source
    }
    const entryID = entryIDs.get(message) ?? id("pi")
    entryIDs.set(message, entryID)
    if (!manager._appendEntry) return original(message)
    manager._appendEntry({
      type: "message",
      id: entryID,
      parentId: manager.getLeafId(),
      timestamp: new Date().toISOString(),
      message,
    })
    return entryID
  }
  return () => {
    manager.appendMessage = original
  }
}

function createPiEventBridge(directory: string, sessionID: string, publish: RuntimeEventPublisher) {
  const entryIDs = new WeakMap<object, string>()
  const startedParts = new Set<string>()
  const toolStarts = new Map<
    string,
    { messageID: string; partID: string; toolName: string; args: unknown; start: number }
  >()
  let currentAssistantMessageID: string | undefined
  let currentUserMessageID: string | undefined

  const ensureEntryID = (message: unknown) => {
    if (!isRecord(message)) return id("pi")
    const existing = entryIDs.get(message)
    if (existing) return existing
    const next = id("pi")
    entryIDs.set(message, next)
    return next
  }

  const ensurePart = (
    nextMessageID: string,
    contentIndex: number,
    type: "text" | "reasoning",
    text = "",
    completed = false,
  ) => {
    const nextPartID = partID(nextMessageID, contentIndex, type)
    const start = Date.now()
    publish("message.part.updated", {
      sessionID,
      time: Date.now(),
      part: {
        id: nextPartID,
        sessionID,
        messageID: nextMessageID,
        type,
        text,
        time: { start, ...(completed ? { end: Date.now() } : {}) },
      },
    })
    startedParts.add(nextPartID)
    return nextPartID
  }

  const publishMessage = (message: unknown, completed = false) => {
    if (!isRecord(message)) return undefined
    if (message.role !== "user" && message.role !== "assistant") return undefined
    const nextMessageID =
      message.role === "assistant" && currentAssistantMessageID
        ? currentAssistantMessageID
        : messageID(ensureEntryID(message))
    if (message.role === "assistant") currentAssistantMessageID = nextMessageID
    publish("message.updated", {
      sessionID,
      info: piMessageInfo(
        directory,
        sessionID,
        nextMessageID,
        message,
        completed,
        message.role === "assistant" ? currentUserMessageID : undefined,
      ),
    })
    return nextMessageID
  }

  const publishToolPart = (
    status: "running" | "completed" | "error",
    input: {
      callID: string
      toolName: string
      args: unknown
      result?: unknown
      isError?: boolean
      start?: number
    },
  ) => {
    const messageID = currentAssistantMessageID ?? id("msg")
    const start = input.start ?? Date.now()
    const part = {
      id: partID(messageID, 0, `tool_${input.callID}`),
      sessionID,
      messageID,
      type: "tool",
      callID: input.callID,
      tool: input.toolName,
      state: {
        status,
        input: input.args,
        ...(status === "running"
          ? {}
          : input.isError
            ? { error: toolOutput(input.result) }
            : { output: toolOutput(input.result), title: input.toolName }),
        metadata: {},
        time: { start, ...(status === "running" ? {} : { end: Date.now() }) },
      },
    }
    publish("message.part.updated", {
      sessionID,
      time: Date.now(),
      part,
    })
    return part
  }

  return {
    entryIDs,
    handle(event: unknown) {
      if (!isRecord(event)) return
      const message = event.message
      if (event.type === "message_start") {
        const nextMessageID = publishMessage(message)
        if (!nextMessageID || !isRecord(message) || message.role !== "user") return
        currentUserMessageID = nextMessageID
        for (const [index, part] of textContentParts(message.content).entries()) {
          ensurePart(nextMessageID, index, "text", part.text, true)
        }
        return
      }

      if (event.type === "message_update") {
        if (!isRecord(message) || message.role !== "assistant") return
        const nextMessageID = publishMessage(message)
        if (nextMessageID) currentAssistantMessageID = nextMessageID
        const assistantEvent = event.assistantMessageEvent
        if (!nextMessageID || !isRecord(assistantEvent)) return

        const contentIndex = typeof assistantEvent.contentIndex === "number" ? assistantEvent.contentIndex : 0
        const isThinking = String(assistantEvent.type).startsWith("thinking")
        const fieldType: "text" | "reasoning" = isThinking ? "reasoning" : "text"
        const nextPartID = partID(nextMessageID, contentIndex, fieldType)

        if (assistantEvent.type === "text_start" || assistantEvent.type === "thinking_start") {
          ensurePart(nextMessageID, contentIndex, fieldType)
          return
        }
        if (assistantEvent.type === "text_delta" || assistantEvent.type === "thinking_delta") {
          if (!startedParts.has(nextPartID)) ensurePart(nextMessageID, contentIndex, fieldType)
          if (typeof assistantEvent.delta !== "string") return
          publish("message.part.delta", {
            sessionID,
            messageID: nextMessageID,
            partID: nextPartID,
            field: "text",
            delta: assistantEvent.delta,
          })
          return
        }
        if (assistantEvent.type === "text_end" || assistantEvent.type === "thinking_end") {
          ensurePart(
            nextMessageID,
            contentIndex,
            fieldType,
            typeof assistantEvent.content === "string" ? assistantEvent.content : "",
            true,
          )
          return
        }
        return
      }

      if (event.type === "message_end") {
        const nextMessageID = publishMessage(message, true)
        if (nextMessageID && isRecord(message) && message.role === "assistant")
          currentAssistantMessageID = nextMessageID
        if (!nextMessageID || !isRecord(message) || message.role !== "assistant") return
        for (const part of assistantParts(message.content)) {
          ensurePart(nextMessageID, part.index, part.type, part.text, true)
        }
        return
      }

      if (event.type === "tool_execution_start") {
        const callID = typeof event.toolCallId === "string" ? event.toolCallId : id("tool")
        const toolName = typeof event.toolName === "string" ? event.toolName : "tool"
        const start = Date.now()
        const part = publishToolPart("running", {
          callID,
          toolName,
          args: event.args,
          start,
        })
        toolStarts.set(callID, {
          messageID: part.messageID,
          partID: part.id,
          toolName,
          args: event.args,
          start,
        })
        return
      }

      if (event.type === "tool_execution_update") {
        const callID = typeof event.toolCallId === "string" ? event.toolCallId : id("tool")
        const started = toolStarts.get(callID)
        publishToolPart("running", {
          callID,
          toolName: typeof event.toolName === "string" ? event.toolName : (started?.toolName ?? "tool"),
          args: event.args ?? started?.args,
          result: event.partialResult,
          start: started?.start,
        })
        return
      }

      if (event.type === "tool_execution_end") {
        const callID = typeof event.toolCallId === "string" ? event.toolCallId : id("tool")
        const started = toolStarts.get(callID)
        publishToolPart(event.isError ? "error" : "completed", {
          callID,
          toolName: typeof event.toolName === "string" ? event.toolName : (started?.toolName ?? "tool"),
          args: started?.args,
          result: event.result,
          isError: Boolean(event.isError),
          start: started?.start,
        })
        toolStarts.delete(callID)
      }
    },
  }
}

async function waitForPiEventQueue(session: unknown) {
  const queue = (session as { _agentEventQueue?: Promise<unknown> })._agentEventQueue
  if (queue) await queue
}

function requestParts(input: unknown, sessionID: string, messageID: string): MessagePart[] {
  if (!Array.isArray(input)) return []
  return input.flatMap((part): MessagePart[] => {
    if (!part || typeof part !== "object") return []
    const item = part as Json
    if (item.type === "text") {
      return [
        {
          id: typeof item.id === "string" ? item.id : id("prt"),
          type: "text",
          text: typeof item.text === "string" ? item.text : "",
          sessionID,
          messageID,
        },
      ]
    }
    if (item.type === "file") {
      return [
        {
          id: typeof item.id === "string" ? item.id : id("prt"),
          type: "file",
          mime: typeof item.mime === "string" ? item.mime : undefined,
          url: typeof item.url === "string" ? item.url : undefined,
          filename: typeof item.filename === "string" ? item.filename : undefined,
          sessionID,
          messageID,
        },
      ]
    }
    if (item.type === "agent") {
      return [
        {
          id: typeof item.id === "string" ? item.id : id("prt"),
          type: "agent",
          filename: typeof item.name === "string" ? item.name : undefined,
          sessionID,
          messageID,
        },
      ]
    }
    return []
  })
}

function contentToMessageParts(content: Json[], sessionID: string, messageID: string, created: number): MessagePart[] {
  return content.flatMap((part, index): MessagePart[] => {
    if (part.type === "text") {
      return [
        {
          id: partID(messageID, index, "text"),
          type: "text",
          text: typeof part.text === "string" ? part.text : "",
          sessionID,
          messageID,
          time: { start: created, end: created },
        },
      ]
    }
    if (part.type === "file") {
      return [
        {
          id: partID(messageID, index, "file"),
          type: "file",
          mime: typeof part.mime === "string" ? part.mime : undefined,
          url: typeof part.path === "string" ? part.path : undefined,
          filename: typeof part.filename === "string" ? part.filename : undefined,
          sessionID,
          messageID,
          time: { start: created, end: created },
        },
      ]
    }
    return []
  })
}

export class AtreeStore {
  private readonly sessionWriteLocks = new Map<string, Promise<void>>()

  private async withSessionWriteLock<T>(directory: string, sessionID: string, operation: () => Promise<T>): Promise<T> {
    const key = `${directory}\0${sessionID}`
    const previous = this.sessionWriteLocks.get(key) ?? Promise.resolve()
    let release = () => {}
    const current = new Promise<void>((resolve) => {
      release = resolve
    })
    const next = previous.catch(() => {}).then(() => current)
    this.sessionWriteLocks.set(key, next)
    await previous.catch(() => {})
    try {
      return await operation()
    } finally {
      release()
      if (this.sessionWriteLocks.get(key) === next) this.sessionWriteLocks.delete(key)
    }
  }

  canRunPiPrompt() {
    return piExecutionMode() !== "none"
  }

  async resolveDirectory(input: string | undefined) {
    const directory = input || process.cwd()
    await mkdir(directory, { recursive: true })
    return realpath(directory)
  }

  async ensureDirectory(directory: string) {
    await mkdir(sessionsDir(directory), { recursive: true })
    await mkdir(join(directory, ".agents", "skills"), { recursive: true })
    if (!existsSync(rootMetaPath(directory))) {
      await writeJsonYaml(rootMetaPath(directory), {
        version: ATREE_VERSION,
        title: basename(directory),
      })
    }
  }

  async listSkills(directory: string): Promise<SkillInfo[]> {
    await this.ensureDirectory(directory)
    const result = loadSkills({
      cwd: directory,
      agentDir: getAgentDir(),
      skillPaths: atreeSkillRoots(directory),
      includeDefaults: true,
    })
    return Promise.all(
      result.skills.map(async (skill) => ({
        name: skill.name,
        description: skill.description,
        location: skill.filePath,
        content: stripFrontmatter(await readFile(skill.filePath, "utf8")),
      })),
    )
  }

  async listSessions(directory: string, input?: { includeArchived?: boolean; limit?: number }) {
    await this.ensureDirectory(directory)
    let ids: string[] = []
    try {
      ids = await readdir(sessionsDir(directory))
    } catch {
      return []
    }
    const metas = (
      await Promise.all(
        ids.map(async (sessionID) => {
          const meta = await this.readMeta(directory, sessionID)
          return meta ? { meta, info: toSessionInfo(directory, meta) } : undefined
        }),
      )
    ).filter((item): item is { meta: SessionMeta; info: SessionInfo } => !!item)
    const filtered = input?.includeArchived ? metas : metas.filter((item) => !item.info.time.archived)
    filtered.sort((a, b) => {
      const aNextRun = a.meta.schedule ? toScheduleInfo(a.meta.id, a.meta.schedule).nextRun : null
      const bNextRun = b.meta.schedule ? toScheduleInfo(b.meta.id, b.meta.schedule).nextRun : null
      if (typeof aNextRun === "number" && typeof bNextRun === "number") return aNextRun - bNextRun
      if (typeof aNextRun === "number") return -1
      if (typeof bNextRun === "number") return 1
      return b.info.time.updated - a.info.time.updated
    })
    const infos = filtered.map((item) => item.info)
    return typeof input?.limit === "number" ? infos.slice(0, input.limit) : infos
  }

  async listNativeSessions(directory: string, input?: { includeArchived?: boolean; limit?: number }) {
    await this.ensureDirectory(directory)
    let ids: string[] = []
    try {
      ids = await readdir(sessionsDir(directory))
    } catch {
      return []
    }
    const sessions = (
      await Promise.all(
        ids.map(async (sessionID) => {
          const meta = await this.readMeta(directory, sessionID)
          return meta ? toNativeSessionInfo(directory, meta) : undefined
        }),
      )
    ).filter((item): item is NativeSessionInfo => !!item)
    const filtered = input?.includeArchived ? sessions : sessions.filter((item) => !item.meta.archived_at)
    filtered.sort((a, b) => {
      const aNextRun = a.meta.schedule ? toScheduleInfo(a.meta.id, a.meta.schedule).nextRun : null
      const bNextRun = b.meta.schedule ? toScheduleInfo(b.meta.id, b.meta.schedule).nextRun : null
      if (typeof aNextRun === "number" && typeof bNextRun === "number") return aNextRun - bNextRun
      if (typeof aNextRun === "number") return -1
      if (typeof bNextRun === "number") return 1
      return (timestamp(b.meta.updated_at) ?? 0) - (timestamp(a.meta.updated_at) ?? 0)
    })
    return typeof input?.limit === "number" ? filtered.slice(0, input.limit) : filtered
  }

  async createSession(directory: string, input?: { title?: string; metadata?: Json }) {
    await this.ensureDirectory(directory)
    const sessionID = id("ses")
    const now = new Date().toISOString()
    await mkdir(assetsDir(directory, sessionID), { recursive: true })
    const meta: SessionMeta = {
      version: ATREE_VERSION,
      id: sessionID,
      title: input?.title ?? `New session - ${now}`,
      icon: sessionIconFromMetadata(input?.metadata),
      metadata: input?.metadata,
      created_at: now,
      updated_at: now,
      archived_at: null,
    }
    await writeJsonYaml(metaPath(directory, sessionID), meta)
    await writeFile(
      sessionPath(directory, sessionID),
      `${JSON.stringify({
        type: "session",
        version: CURRENT_SESSION_VERSION,
        id: sessionID,
        timestamp: now,
        cwd: directory,
      })}\n`,
    )
    return toSessionInfo(directory, meta)
  }

  async readMeta(directory: string, sessionID: string) {
    const meta = await readJsonYaml<SessionMeta>(metaPath(directory, sessionID))
    if (meta) await ensureSessionHeaderCwd(directory, sessionID)
    return meta
  }

  async requireSession(directory: string, sessionID: string) {
    const meta = await this.readMeta(directory, sessionID)
    if (!meta) throw new Response("Session not found", { status: 404 })
    return meta
  }

  async getSession(directory: string, sessionID: string) {
    return toSessionInfo(directory, await this.requireSession(directory, sessionID))
  }

  async getNativeSession(directory: string, sessionID: string) {
    return toNativeSessionInfo(directory, await this.requireSession(directory, sessionID))
  }

  async updateSession(
    directory: string,
    sessionID: string,
    patch: { title?: string; metadata?: Json; time?: { archived?: number | null } },
  ) {
    return this.withSessionWriteLock(directory, sessionID, async () => {
      const meta = await this.requireSession(directory, sessionID)
      const nextMetadata = patch.metadata ?? meta.metadata
      const next: SessionMeta = {
        ...meta,
        title: patch.title ?? meta.title,
        icon: patch.metadata ? (sessionIconFromMetadata(patch.metadata) ?? meta.icon) : meta.icon,
        metadata: nextMetadata,
        updated_at: new Date().toISOString(),
      }
      if (patch.time && "archived" in patch.time) {
        next.archived_at = typeof patch.time.archived === "number" ? new Date(patch.time.archived).toISOString() : null
        if (next.archived_at) delete next.schedule
      }
      await writeJsonYaml(metaPath(directory, sessionID), next)
      return toSessionInfo(directory, next)
    })
  }

  async shareSession(directory: string, sessionID: string, share: string) {
    return this.withSessionWriteLock(directory, sessionID, async () => {
      const meta = await this.requireSession(directory, sessionID)
      const next: SessionMeta = {
        ...meta,
        share: { url: share },
        updated_at: new Date().toISOString(),
      }
      await writeJsonYaml(metaPath(directory, sessionID), next)
      return toSessionInfo(directory, next)
    })
  }

  async unshareSession(directory: string, sessionID: string) {
    return this.withSessionWriteLock(directory, sessionID, async () => {
      const meta = await this.requireSession(directory, sessionID)
      const { share: _share, ...next } = meta
      await writeJsonYaml(metaPath(directory, sessionID), {
        ...next,
        updated_at: new Date().toISOString(),
      })
      return toSessionInfo(directory, next as SessionMeta)
    })
  }

  async revertSession(
    directory: string,
    sessionID: string,
    input: { messageID: string; partID?: string; snapshot?: string; diff?: string },
  ) {
    if (!input.messageID) throw new Response("messageID is required", { status: 400 })
    return this.withSessionWriteLock(directory, sessionID, async () => {
      const meta = await this.requireSession(directory, sessionID)
      const next: SessionMeta = {
        ...meta,
        revert: {
          messageID: input.messageID,
          partID: input.partID,
          snapshot: input.snapshot,
          diff: input.diff,
        },
        updated_at: new Date().toISOString(),
      }
      await writeJsonYaml(metaPath(directory, sessionID), next)
      return toSessionInfo(directory, next)
    })
  }

  async unrevertSession(directory: string, sessionID: string) {
    return this.withSessionWriteLock(directory, sessionID, async () => {
      const meta = await this.requireSession(directory, sessionID)
      const { revert: _revert, ...next } = meta
      await writeJsonYaml(metaPath(directory, sessionID), {
        ...next,
        updated_at: new Date().toISOString(),
      })
      return toSessionInfo(directory, next as SessionMeta)
    })
  }

  async abortSession(directory: string, sessionID: string) {
    await this.requireSession(directory, sessionID)
    return true
  }

  async summarizeSession(directory: string, sessionID: string, _input?: { providerID?: string; modelID?: string; auto?: boolean }) {
    await this.requireSession(directory, sessionID)
    return true
  }

  async deleteSession(directory: string, sessionID: string) {
    return this.withSessionWriteLock(directory, sessionID, async () => {
      await rm(sessionDir(directory, sessionID), { recursive: true, force: true })
      return true
    })
  }

  async listMessages(directory: string, sessionID: string): Promise<MessageWithParts[]> {
    await this.requireSession(directory, sessionID)
    let content = ""
    try {
      content = await readFile(sessionPath(directory, sessionID), "utf8")
    } catch {
      return []
    }
    const entries = parseSessionEntries(content)
    const toolResults = new Map<string, Json>()
    for (const entry of entries) {
      if (entry.type !== "message") continue
      const message = entry.message
      if (!isRecord(message) || message.role !== "toolResult" || typeof message.toolCallId !== "string") continue
      toolResults.set(message.toolCallId, message)
    }
    return entries.flatMap((entry): MessageWithParts[] => {
      if (entry.type !== "message") return []
      const message = entry.message
      if (!message || typeof message !== "object") return []
      const item = message as Json
      const nextMessageID = typeof entry.id === "string" ? messageID(entry.id) : id("msg")
      const created = timestamp(typeof entry.timestamp === "string" ? entry.timestamp : undefined) ?? Date.now()
      if (item.role === "user") {
        const parts = userContentParts(item.content)
        return [
          {
            info: {
              id: nextMessageID,
              sessionID,
              role: "user",
              time: { created },
              agent: userMessageAgent(item),
              model: { providerID: "pi", modelID: "default" },
            },
            parts: parts.map((part, index) =>
              part.type === "text"
                ? {
                    id: partID(nextMessageID, index, "text"),
                    sessionID,
                    messageID: nextMessageID,
                    type: "text",
                    text: part.text,
                    time: { start: created, end: created },
                  }
                : {
                    id: partID(nextMessageID, index, "file"),
                    sessionID,
                    messageID: nextMessageID,
                    type: "file",
                    url: part.path,
                    mime: part.mime,
                    filename: part.filename,
                    time: { start: created, end: created },
                  },
            ),
          },
        ]
      }
      if (item.role === "assistant") {
        const usage = isRecord(item.usage) ? item.usage : undefined
        const parentID = typeof entry.parentId === "string" ? messageID(entry.parentId) : undefined
        return [
          {
            info: {
              id: nextMessageID,
              sessionID,
              role: "assistant",
              time: { created, completed: created },
              ...(parentID ? { parentID } : {}),
              modelID: typeof item.model === "string" ? item.model : "default",
              providerID: typeof item.provider === "string" ? item.provider : "pi",
              mode: "build",
              agent: "pi",
              path: { cwd: directory, root: directory },
              cost: usageCost(usage),
              tokens: usageTokens(usage),
            },
            parts: assistantContentParts(nextMessageID, sessionID, item.content, toolResults, created),
          },
        ]
      }
      return []
    })
  }

  async listNativeEntries(directory: string, sessionID: string) {
    await this.requireSession(directory, sessionID)
    let content = ""
    try {
      content = await readFile(sessionPath(directory, sessionID), "utf8")
    } catch {
      return []
    }
    return parseSessionEntries(content)
  }

  async appendUserPrompt(
    directory: string,
    sessionID: string,
    input: { messageID?: string; agent?: string; model?: Json; parts?: unknown; source?: Json },
  ) {
    return this.withSessionWriteLock(directory, sessionID, async () => {
      const meta = await this.requireSession(directory, sessionID)
      const now = new Date()
      const content = await requestContent(directory, sessionID, input.parts)
      const manager = openPiSession(directory, sessionID)
      const entryID = manager.appendMessage({
        role: "user",
        content,
        timestamp: now.getTime(),
        ...(isRecord(input.source) ? { source: input.source } : {}),
      })
      // Pi normally flushes early user messages when the assistant answer lands.
      // The web UI needs optimistic user messages to survive a refresh immediately.
      flushPiSession(manager)
      await writeJsonYaml(metaPath(directory, sessionID), {
        ...meta,
        updated_at: now.toISOString(),
      })
      const messageID = typeof input.messageID === "string" ? input.messageID : `msg_${entryID}`
      const model = input.model ?? {}
      const info: MessageInfo = {
        id: messageID,
        sessionID,
        role: "user",
        time: { created: now.getTime() },
        agent: typeof input.agent === "string" ? input.agent : "pi",
        model: {
          providerID: typeof model.providerID === "string" ? model.providerID : "pi",
          modelID: typeof model.modelID === "string" ? model.modelID : "default",
          ...(typeof model.variant === "string" ? { variant: model.variant } : {}),
        },
      }
      const parts = contentToMessageParts(content, sessionID, messageID, now.getTime())
      return { info, parts }
    })
  }

  async runPiPrompt(
    directory: string,
    sessionID: string,
    input: { parts?: unknown; publish?: RuntimeEventPublisher; source?: Json },
  ): Promise<MessageWithParts[]> {
    return this.withSessionWriteLock(directory, sessionID, async () => {
      const meta = await this.requireSession(directory, sessionID)
      const before = await this.listMessages(directory, sessionID)
      const text = requestText(input.parts)
      const content = await requestContent(directory, sessionID, input.parts)
      const sessionManager = openPiSession(directory, sessionID)
      const mode = piExecutionMode()
      const fauxToolPrompt: FauxToolPrompt | undefined = text.includes("contract pi tool prompt")
        ? "echo"
        : text.includes("contract pi read tool prompt")
          ? "read"
          : text.includes("contract pi write tool prompt")
            ? "write"
            : text.includes("contract pi edit tool prompt")
              ? "edit"
              : text.includes("contract pi bash tool prompt")
                ? "bash"
                : undefined
      const runtime =
        mode === "faux" ? createFauxRuntime(`atree faux response: ${text}`, { toolPrompt: fauxToolPrompt }) : undefined

      if (mode === "none") throw new Response("Pi execution is disabled", { status: 501 })

      const bridge = input.publish ? createPiEventBridge(directory, sessionID, input.publish) : undefined
      const entryIDs = bridge?.entryIDs ?? new WeakMap<object, string>()
      const restoreAppendMessage =
        bridge || isRecord(input.source) || content.length
          ? patchSessionMessageIDs(sessionManager, entryIDs, input.source, content)
          : undefined
      const { session } = await createAgentSession({
        cwd: directory,
        sessionManager,
        resourceLoader: await createAtreeResourceLoader(directory),
        ...(runtime
          ? {
              authStorage: runtime.authStorage,
              modelRegistry: runtime.modelRegistry,
              model: runtime.model,
              noTools: "builtin" as const,
              customTools: [atreeEchoTool],
              tools:
                fauxToolPrompt === "echo"
                  ? ["atree_echo"]
                  : fauxToolPrompt === "read"
                    ? ["read"]
                    : fauxToolPrompt === "write"
                      ? ["write"]
                      : fauxToolPrompt === "edit"
                        ? ["edit"]
                        : fauxToolPrompt === "bash"
                          ? ["bash"]
                          : [],
            }
          : {}),
      })

      const unsubscribe = bridge
        ? session.subscribe((event) => {
            try {
              bridge.handle(event)
            } catch (error) {
              console.error("Failed to map Pi session event", error)
            }
          })
        : undefined
      try {
        await session.bindExtensions({})
        if (mode === "faux") {
          const delay = fauxPromptDelayMs()
          if (delay > 0) await sleep(delay)
        }
        await session.prompt(text, {
          expandPromptTemplates: false,
          source: "rpc",
        })
        await waitForPiEventQueue(session)
      } finally {
        unsubscribe?.()
        restoreAppendMessage?.()
        session.dispose()
      }

      await writeJsonYaml(metaPath(directory, sessionID), {
        ...meta,
        updated_at: new Date().toISOString(),
      })

      const after = await this.listMessages(directory, sessionID)
      return after.slice(before.length)
    })
  }

  async listSchedules(directory: string, sessionID: string) {
    const meta = await this.requireSession(directory, sessionID)
    return meta.schedule ? [toScheduleInfo(sessionID, meta.schedule)] : []
  }

  async listDueSchedules(directory: string, now = Date.now()): Promise<DueSchedule[]> {
    await this.ensureDirectory(directory)
    let ids: string[] = []
    try {
      ids = await readdir(sessionsDir(directory))
    } catch {
      return []
    }

    const due = (
      await Promise.all(
        ids.map(async (sessionID) => {
          const meta = await this.readMeta(directory, sessionID)
          if (!meta || meta.archived_at || !meta.schedule) return
          if (meta.schedule.kind === "at") {
            const runAt = atScheduleRunAt(meta.schedule)
            if (runAt === undefined || runAt > now) return
            return {
              sessionID,
              schedule: meta.schedule,
              info: toScheduleInfo(sessionID, meta.schedule),
              runAt,
            }
          }
          const runAt = nextCronRun(meta.schedule)
          if (!runAt || runAt > now) return
          return {
            sessionID,
            schedule: meta.schedule,
            info: toScheduleInfo(sessionID, meta.schedule),
            runAt,
          }
        }),
      )
    ).filter((item): item is DueSchedule => !!item)

    due.sort((a, b) => a.runAt - b.runAt)
    return due
  }

  async createSchedule(
    directory: string,
    sessionID: string,
    input: { type?: "cron" | "at"; cron?: string; at?: number | string; message: string },
  ) {
    return this.withSessionWriteLock(directory, sessionID, async () => {
      const meta = await this.requireSession(directory, sessionID)
      if (meta.schedule) throw new Response("Session already has a schedule", { status: 409 })
      const now = new Date().toISOString()
      const scheduleID = id("sch")
      const schedule: ScheduleMeta =
        input.type === "cron" || input.cron
          ? {
              id: scheduleID,
              kind: "cron",
              expression: normalizeCronExpression(input.cron),
              message: input.message,
              created_at: now,
              last_ran_at: null,
              last_run_status: null,
            }
          : {
              id: scheduleID,
              kind: "at",
              run_at: new Date(normalizeRunAt(input.at)).toISOString(),
              message: input.message,
              created_at: now,
              last_ran_at: null,
              last_run_status: null,
            }
      await writeJsonYaml(metaPath(directory, sessionID), {
        ...meta,
        schedule,
        updated_at: now,
      })
      return toScheduleInfo(sessionID, schedule)
    })
  }

  async deleteSchedule(directory: string, sessionID: string, scheduleID: string) {
    return this.withSessionWriteLock(directory, sessionID, async () => {
      const meta = await this.requireSession(directory, sessionID)
      if (!meta.schedule || meta.schedule.id !== scheduleID) throw new Response("Schedule not found", { status: 404 })
      const { schedule: _, ...next } = meta
      await writeJsonYaml(metaPath(directory, sessionID), {
        ...next,
        updated_at: new Date().toISOString(),
      })
      return true
    })
  }

  async completeDueSchedule(
    directory: string,
    sessionID: string,
    scheduleID: string,
    input?: { ranAt?: number; status?: "ran" | "skipped" },
  ) {
    return this.withSessionWriteLock(directory, sessionID, async () => {
      const meta = await this.requireSession(directory, sessionID)
      if (!meta.schedule || meta.schedule.id !== scheduleID) return "missing" as const
      const now = new Date(input?.ranAt ?? Date.now()).toISOString()
      const status = input?.status ?? "ran"
      if (meta.schedule.kind === "cron") {
        const next: SessionMeta = {
          ...meta,
          updated_at: now,
          schedule: {
            ...meta.schedule,
            last_ran_at: now,
            last_run_status: status,
          },
        }
        await writeJsonYaml(metaPath(directory, sessionID), next)
        return "updated" as const
      }
      const { schedule: _, ...next } = meta
      await writeJsonYaml(metaPath(directory, sessionID), {
        ...next,
        updated_at: now,
      })
      return "deleted" as const
    })
  }

  async storageStat(directory: string, sessionID: string) {
    const root = sessionDir(directory, sessionID)
    const session = await stat(sessionPath(directory, sessionID))
    return { root, sessionJsonl: sessionPath(directory, sessionID), size: session.size }
  }
}

function normalizeRunAt(value: number | string | undefined) {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string") {
    const time = new Date(value).getTime()
    if (Number.isFinite(time)) return time
  }
  return Date.now() + 60_000
}

function isTextContent(value: unknown): value is { type: "text"; text: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "text" &&
    typeof (value as { text?: unknown }).text === "string"
  )
}

function isFileContent(value: unknown): value is { type: "file"; path: string; mime?: string; filename?: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "file" &&
    typeof (value as { path?: unknown }).path === "string"
  )
}

function isThinkingContent(value: unknown): value is { type: "thinking"; thinking: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "thinking" &&
    typeof (value as { thinking?: unknown }).thinking === "string"
  )
}

function isToolCallContent(value: unknown): value is { type: "toolCall"; id: string; name: string; arguments: Json } {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "toolCall" &&
    typeof (value as { id?: unknown }).id === "string" &&
    typeof (value as { name?: unknown }).name === "string" &&
    isRecord((value as { arguments?: unknown }).arguments)
  )
}

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
