import { type ServerConnection } from "@/context/server"
import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import { sessionScheduleRequestHeaders } from "@/utils/session-schedule"

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

type NativeEntry = {
  type?: string
  id?: string
  parentId?: string | null
  timestamp?: string | number
  message?: unknown
}

export type AtreeMessagePage = {
  session: Message[]
  part: { id: string; part: Part[] }[]
  cursor?: string
  complete: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function timestamp(value: unknown) {
  if (!value) return undefined
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value !== "string") return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function messageID(entryID: string) {
  return `msg_${entryID}`
}

function partID(messageID: string, contentIndex = 0, type = "text") {
  return `${messageID}_part_${contentIndex}_${type}`
}

function isTextContent(value: unknown): value is { type: "text"; text: string } {
  return isRecord(value) && value.type === "text" && typeof value.text === "string"
}

function isFileContent(value: unknown): value is { type: "file"; path: string; mime?: string; filename?: string } {
  return isRecord(value) && value.type === "file" && typeof value.path === "string"
}

function isThinkingContent(value: unknown): value is { type: "thinking"; thinking: string } {
  return isRecord(value) && value.type === "thinking" && typeof value.thinking === "string"
}

function isToolCallContent(value: unknown): value is { type: "toolCall"; id: string; name: string; arguments: Json } {
  return (
    isRecord(value) &&
    value.type === "toolCall" &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    isRecord(value.arguments)
  )
}

function userContentParts(content: unknown) {
  if (typeof content === "string") return [{ type: "text" as const, text: content }]
  if (!Array.isArray(content)) return []
  return content.filter(
    (
      part,
    ): part is { type: "text"; text: string } | { type: "file"; path: string; mime?: string; filename?: string } =>
      isTextContent(part) || isFileContent(part),
  )
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

function toolResultOutput(message: Record<string, unknown> | undefined) {
  if (!message) return ""
  const details = message.details
  if (isRecord(details) && typeof details.output === "string") return details.output
  const content = contentText(message.content)
  if (content) return content
  return JSON.stringify(message)
}

function usageTokens(usage: Record<string, unknown> | undefined) {
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

function usageCost(usage: Record<string, unknown> | undefined) {
  const cost = usage?.cost
  if (!isRecord(cost)) return 0
  return typeof cost.total === "number" ? cost.total : 0
}

function userMessageAgent(message: Record<string, unknown>) {
  const source = message.source
  return isRecord(source) && source.type === "schedule" ? "automation" : "pi"
}

function assistantContentParts(
  nextMessageID: string,
  sessionID: string,
  content: unknown,
  toolResults: Map<string, Record<string, unknown>>,
  created: number,
): Part[] {
  if (!Array.isArray(content)) return []
  return content.flatMap((part, index): Part[] => {
    if (isTextContent(part)) {
      return [
        {
          id: partID(nextMessageID, index, "text"),
          sessionID,
          messageID: nextMessageID,
          type: "text",
          text: part.text,
          time: { start: created, end: created },
        } as Part,
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
        } as Part,
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
        } as Part,
      ]
    }
    return []
  })
}

function toMessagePage(directory: string, sessionID: string, entries: NativeEntry[]): AtreeMessagePage {
  const toolResults = new Map<string, Record<string, unknown>>()
  for (const entry of entries) {
    if (entry.type !== "message") continue
    const message = entry.message
    if (!isRecord(message) || message.role !== "toolResult" || typeof message.toolCallId !== "string") continue
    toolResults.set(message.toolCallId, message)
  }

  const items = entries.flatMap((entry): Array<{ info: Message; parts: Part[] }> => {
    if (entry.type !== "message") return []
    const message = entry.message
    if (!isRecord(message)) return []

    const nextMessageID = typeof entry.id === "string" ? messageID(entry.id) : `msg_${crypto.randomUUID()}`
    const created = timestamp(entry.timestamp) ?? Date.now()
    if (message.role === "user") {
      const parts = userContentParts(message.content)
      return [
        {
          info: {
            id: nextMessageID,
            sessionID,
            role: "user",
            time: { created },
            agent: userMessageAgent(message),
            model: { providerID: "pi", modelID: "default" },
          } as Message,
          parts: parts.map((part, index) =>
            part.type === "text"
              ? ({
                  id: partID(nextMessageID, index, "text"),
                  sessionID,
                  messageID: nextMessageID,
                  type: "text",
                  text: part.text,
                  time: { start: created, end: created },
                } as Part)
              : ({
                  id: partID(nextMessageID, index, "file"),
                  sessionID,
                  messageID: nextMessageID,
                  type: "file",
                  url: part.path,
                  mime: part.mime,
                  filename: part.filename,
                  time: { start: created, end: created },
                } as Part),
          ),
        },
      ]
    }

    if (message.role === "assistant") {
      const usage = isRecord(message.usage) ? message.usage : undefined
      const parentID = typeof entry.parentId === "string" ? messageID(entry.parentId) : undefined
      return [
        {
          info: {
            id: nextMessageID,
            sessionID,
            role: "assistant",
            time: { created, completed: created },
            ...(parentID ? { parentID } : {}),
            modelID: typeof message.model === "string" ? message.model : "default",
            providerID: typeof message.provider === "string" ? message.provider : "pi",
            mode: "build",
            agent: "pi",
            path: { cwd: directory, root: directory },
            cost: usageCost(usage),
            tokens: usageTokens(usage),
          } as Message,
          parts: assistantContentParts(nextMessageID, sessionID, message.content, toolResults, created),
        },
      ]
    }

    return []
  })

  const session = items.map((item) => item.info).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const part = items.map((item) => ({
    id: item.info.id,
    part: item.parts.filter((part) => !!part?.id).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  }))
  return {
    session,
    part,
    complete: true,
  }
}

function responseError(method: string, path: string, status: number, text: string) {
  return Object.assign(new Error(`${method} ${path} failed: ${status} ${text}`), {
    cause: { status },
  })
}

export async function listAtreeMessages(input: {
  current: ServerConnection.Any | null | undefined
  directory: string
  sessionID: string
}) {
  if (!input.current) {
    return {
      session: [],
      part: [],
      complete: true,
    } satisfies AtreeMessagePage
  }
  const path = `/atree/session/${input.sessionID}/entries`
  const url = new URL(path, input.current.http.url)
  url.searchParams.set("directory", input.directory)
  const response = await fetch(url, { headers: sessionScheduleRequestHeaders(input.current) })
  if (!response.ok) throw responseError("GET", path, response.status, await response.text())
  const entries = (await response.json()) as NativeEntry[]
  return toMessagePage(input.directory, input.sessionID, entries)
}
