import fs from "fs/promises"
import path from "path"
import type { PermissionV1 } from "@opencode-ai/core/v1/permission"
import type { Request as QuestionRequest } from "@/question"
import { readSessionStores } from "./session-store"

type RecordValue = Record<string, unknown>

export type InteractionState = {
  questions: QuestionRequest[]
  permissions: PermissionV1.Request[]
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

export async function readSessionInteractionState(directory: string): Promise<InteractionState> {
  const sessions = await readSessionStores(directory)
  const questions = new Map<string, QuestionRequest>()
  const permissions = new Map<string, PermissionV1.Request>()

  for (const session of sessions) {
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
        if (typeof question.id === "string") questions.set(question.id, question as QuestionRequest)
        continue
      }
      if (type === "question.replied" || type === "question.rejected") {
        if (typeof data.requestID === "string") questions.delete(data.requestID)
        continue
      }

      if (type === "permission.asked") {
        const permission = isRecord(data.permission) ? data.permission : data
        if (typeof permission.id === "string") permissions.set(permission.id, permission as PermissionV1.Request)
        continue
      }
      if (type === "permission.replied") {
        if (typeof data.requestID === "string") permissions.delete(data.requestID)
      }
    }
  }

  return {
    questions: [...questions.values()],
    permissions: [...permissions.values()],
  }
}
