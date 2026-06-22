import fs from "fs/promises"
import path from "path"
import type { QuestionV2 } from "../question"
import { readSessionStoresDeep, readWorkspaceRoot } from "./session-store"

type RecordValue = Record<string, unknown>
export type QuestionStateEntry = {
  readonly request: QuestionV2.Request
  readonly directory: string
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

export async function readQuestionStateEntries(rootDirectory?: string) {
  const rootInput = rootDirectory ?? (await readWorkspaceRoot())
  if (!rootInput) return [] as QuestionStateEntry[]

  const sessions = await readSessionStoresDeep(rootInput)
  const questions = new Map<string, QuestionStateEntry>()

  for (const session of sessions) {
    const raw = await fs.readFile(sessionJsonlPath(session.location.directory, session.id), "utf8").catch((error: unknown) => {
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

      if (type === "question.v2.asked") {
        const question = isRecord(data.question) ? data.question : data
        if (typeof question.id === "string")
          questions.set(question.id, { request: question as QuestionV2.Request, directory: session.location.directory })
        continue
      }
      if (type === "question.v2.replied" || type === "question.v2.rejected") {
        if (typeof data.requestID === "string") questions.delete(data.requestID)
      }
    }
  }

  return [...questions.values()]
}

export async function readQuestionState(rootDirectory?: string) {
  return (await readQuestionStateEntries(rootDirectory)).map((entry) => entry.request)
}
