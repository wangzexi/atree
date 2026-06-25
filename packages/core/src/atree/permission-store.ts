import fs from "fs/promises"
import path from "path"
import type { PermissionV2 } from "../permission"
import { readSessionStoresDeep, readWorkspaceSessionStoresDeep } from "./session-store"

type RecordValue = Record<string, unknown>
export type PermissionStateEntry = {
  readonly request: PermissionV2.Request
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

export async function readPermissionStateEntries(rootDirectory?: string) {
  const sessions = rootDirectory
    ? await readSessionStoresDeep(rootDirectory)
    : await readWorkspaceSessionStoresDeep()
  if (sessions.length === 0) return [] as PermissionStateEntry[]
  const permissions = new Map<string, PermissionStateEntry>()

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

      if (type === "permission.v2.asked") {
        const permission = isRecord(data.permission) ? data.permission : data
        if (typeof permission.id === "string")
          permissions.set(permission.id, {
            request: permission as PermissionV2.Request,
            directory: session.location.directory,
          })
        continue
      }
      if (type === "permission.v2.replied") {
        if (typeof data.requestID === "string") permissions.delete(data.requestID)
      }
    }
  }

  return [...permissions.values()]
}

export async function readPermissionState(rootDirectory?: string) {
  return (await readPermissionStateEntries(rootDirectory)).map((entry) => entry.request)
}
