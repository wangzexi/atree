import fs from "fs/promises"
import path from "path"
import type { PermissionV1 } from "@opencode-ai/core/v1/permission"
import type { Request as QuestionRequest } from "@/question"
import { readSessionStoresDeep } from "./session-store"

type RecordValue = Record<string, unknown>

export type InteractionState = {
  questions: QuestionRequest[]
  permissions: PermissionV1.Request[]
}

export type DirectoryScopedInteraction = {
  directory?: string
}

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function eventType(value: unknown) {
  return typeof value === "string" ? value.replace(/\.\d+$/, "") : undefined
}

function eventData(entry: RecordValue) {
  return isRecord(entry.data) ? entry.data : entry
}

function sessionJsonlPath(directory: string, sessionID: string) {
  return path.join(directory, ".agents", "atree", "sessions", sessionID, "session.jsonl")
}

function pendingKey(directory: string, sessionID: string, requestID: string) {
  return `${path.resolve(directory)}\0${sessionID}\0${requestID}`
}

export async function readSessionInteractionState(directory: string): Promise<InteractionState> {
  const sessions = await readSessionStoresDeep(directory)
  const questions = new Map<string, QuestionRequest>()
  const permissions = new Map<string, PermissionV1.Request>()

  for (const session of sessions) {
    if (session.time.archived !== undefined) continue
    const raw = await fs.readFile(sessionJsonlPath(session.directory, session.id), "utf8").catch((error: unknown) => {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return ""
      throw error
    })

    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue
      let entry: RecordValue
      try {
        entry = JSON.parse(line) as RecordValue
      } catch {
        continue
      }

      const type = eventType(entry.type)
      const data = eventData(entry)

      if (type === "question.asked") {
        const question = isRecord(data.question) ? data.question : data
        if (typeof question.id === "string") {
          const request = question as QuestionRequest & DirectoryScopedInteraction
          Object.defineProperty(request, "directory", { value: session.directory, enumerable: false })
          questions.set(pendingKey(session.directory, session.id, question.id), request)
        }
        continue
      }
      if (type === "question.replied" || type === "question.rejected") {
        if (typeof data.requestID === "string") questions.delete(pendingKey(session.directory, session.id, data.requestID))
        continue
      }

      if (type === "permission.asked") {
        const permission = isRecord(data.permission) ? data.permission : data
        if (typeof permission.id === "string") {
          const request = permission as PermissionV1.Request & DirectoryScopedInteraction
          Object.defineProperty(request, "directory", { value: session.directory, enumerable: false })
          permissions.set(pendingKey(session.directory, session.id, permission.id), request)
        }
        continue
      }
      if (type === "permission.replied") {
        if (typeof data.requestID === "string") {
          permissions.delete(pendingKey(session.directory, session.id, data.requestID))
        }
      }
    }
  }

  return {
    questions: [...questions.values()],
    permissions: [...permissions.values()],
  }
}
